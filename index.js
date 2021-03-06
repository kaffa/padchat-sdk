'use strict'

const EventEmitter = require('events')
const Websocket    = require('ws')
const UUID         = require('uuid')

const Helper = require('./helper')
const {
  wsEventType,
  loginType,
  blacklist,
} = require('./define')

const server = 'ws://127.0.0.1:7777'

/**
 * Padchat模块
 *
 * 使用websocket与服务器进行通讯，拥有以下事件
 *
 * Event | 说明
 * ---- | ----
 * qrcode | 推送的二维码
 * scan | 扫码状态
 * push | 新信息事件
 * login | 登录
 * loaded | 通讯录载入完毕
 * logout | 注销登录
 * over | 实例注销（账号不退出）（要再登录需要重新调用init）
 * warn | 错误信息
 * sns | 朋友圈更新事件
 *
 * **接口返回数据结构：** 所有接口均返回以下结构数据：
 * ```
 {
   success: true,   // 执行是否成功
   err    : '',     // 错误提示
   msg    : '',     // 附加信息
   data   : {}      // 返回结果
 }
 * ```
 *
 * TODO: 补充各监听事件返回的数据定义
 *
 * @class Padchat
 * @extends {EventEmitter}
 */
class Padchat extends EventEmitter {
  /**
   * Creates an instance of Padchat.
   * @param {string} [url] - 服务器url，默认为：`ws://127.0.0.1:7777`
   * @memberof Padchat
   */
  constructor(url = server) {
    super()
    this.url    = url
    this._event = new EventEmitter()
    // 向ws服务器提交指令后，返回结果的超时时间，单位毫秒
    this.sendTimeout    = 10 * 1000
    this.connected      = false
    this._lastStartTime = 0
    this.ws             = {}
    this.start()
  }

  /**
   * 启动websocket连接
   *
   * @memberof Padchat
   */
  async start() {
    // 限制启动ws连接间隔时间
    if (Date.now() - this._lastStartTime < 200) {
      throw new Error('建立ws连接时间间隔过短!')
    }
    this._lastStartTime = Date.now()
    if (this.ws instanceof Websocket && this.ws.readyState === this.ws.OPEN) {
      this.ws.terminate()
    }
    this.ws = new Websocket(this.url)
      .on('message', (msg) => {
        onWsMsg.call(this, msg)
      })
      .on('open', () => {
        this.connected = true
        this.emit('open')
      })
      .on('close', () => {
        this.connected = false
        this.emit('close')
      })
      .on('error', (e) => {
        this.emit('error', e)
      })
  }

  /**
  * ws发送数据
  *
  * @param {object} data - 数据
  * @returns {Promise<object>} 返回ws处理结果
  * @private
  * @memberof Padchat
  */
  async _send(data) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !(this.ws instanceof Websocket)) {
        reject('websocket未连接!')
      }
      this.ws.send(JSON.stringify(data), e => {
        if (e) {
          reject(new Error(`ws发送数据失败! err: ${e.message}`))
        } else {
          resolve(true)
        }
      })
    })
  }

  /**
  * 包装ws发送数据
  *
  * @param {object} data - 要发送的数据
  * @param {number} timeout - 发送超时时间
  * @returns {Promise<object>} 返回ws处理结果
  * @private
  * @memberof Padchat
  */
  async asyncSend(data, timeout = 30000) {
    if (!data.cmdId) {
      data.cmdId = UUID.v1()
    }
    return new Promise((res, rej) => {
      try {
        getCmdRecv.call(this, data.cmdId, timeout)
          .then(data => {
            // console.info('getCmdRecv ret data:', data)
            res(data.data)
          })
        this._send(data)
          .then(async ret => {
            // console.info('asyncSend ret: %s', ret)
            return ret
          })
      } catch (e) {
        rej(e)
      }
    })
  }

  /**
  * 包装ws发送指令数据包
  *
  * @param {string} cmd - 要操作的接口
  * @param {object} data - 要发送的数据
  * @returns {Promise<object>} 返回ws处理结果
  * @private
  * @memberof Padchat
  */
  async sendCmd(cmd, data = {}) {
    if (data.rawMsgData) {
      // 清洗掉无用而占空间的字段
      data.rawMsgData = clearRawMsg(data.rawMsgData)
      data.rawMsgData = Helper.toUnderLine(data.rawMsgData)
    }

    return await this.asyncSend({
      type: 'user',
      cmd,
      data,
    })
      .then(ret => {
        // 用于抓取操作接口对应的返回数据，便于写入文档
        this.emit('cmdRet', cmd, ret)
        return ret
      })
      .catch(e => {
        throw e
      })
  }

  /**
  * 初始化
  *
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    error  : '',
    success: true
  }
  * ```
  * @memberof Padchat
  */
  async init() {
    return await this.sendCmd('init')
  }

  /**
  * 关闭微信实例（不退出登陆）
  *
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * @memberof Padchat
  */
  async close() {
    return await this.sendCmd('close')
  }

  /**
  * 登录账号
  * 首次登录不需要传入`wxData`，登陆成功后本地保存`wxData`和`token`，以后使用断线重连或二次登陆，可降低封号概率。
  * 任何登陆方式，使用成功登陆过的`wxData`都可降低封号概率。
  *
  * @param {string} type - 登录类型，默认为扫码登录
  * <br> `token` **断线重连**，用于短时间使用`wxData`和`token`再次登录。`token`有效期很短，如果登陆失败，建议使用二次登陆方式
  * <br> `request` **二次登陆**。需要提供`wxData`和`token`数据，手机端会弹出确认框，点击后登陆。不容易封号
  * <br> `qrcode` **扫码登录**（现在此模式已经可以返回二维码内容的url了）
  * <br> `phone` **手机验证码登录**，建议配合`wxData`使用
  * <br> `user` **账号密码登录**，建议配合`wxData`使用
  *
  * @param {object} data - 附加数据
  * @param {string} [data.wxData] - 设备信息数据，登录后使用 `getDeviceInfo` 接口获得。<br>使用此数据可免设备安全验证，不容易封号
  * @param {string} [data.token] - 使用用任意方式登录成功后，使用 `getAutoLoginData` 接口获得。 <br>此token有过期时间，断开登录状态一段时间后会过期。
  * @param {string} [data.phone] - 手机号
  * @param {string} [data.code] - 手机验证码
  * @param {string} [data.username] - 用户名/qq号/手机号
  * @param {string} [data.password] - 密码
  *
  * @example <caption>扫码登陆</caption>
  * const wx = new Padchat()
  * await wx.init()
  * await wx.login('qrcode',{wxData:'xxx'})
  *
  * @example <caption>账号密码登陆</caption>
  * const wx = new Padchat()
  * await wx.init()
  * await wx.login('user',{wxData:'xxx',username:'name',password:'123456'})
  *
  * @example <caption>手机验证码</caption>
  * const wx = new Padchat()
  * await wx.init()
  * await wx.login('phone',{wxData:'xxx',phone:'13512345678',code:'123456'})
  *
  * @example <caption>断线重连</caption>
  * const wx = new Padchat()
  * await wx.init()
  * await wx.login('token',{wxData:'xxx',token:'xxxxx'})
  *
  * @example <caption>二次登陆</caption>
  * const wx = new Padchat()
  * await wx.init()
  * await wx.login('request',{wxData:'xxx',token:'xxxxx'})
  *
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    error  : '',
    msg    : '请使用手机微信扫码登陆！',
    success: true
  }
  * ```
  * @memberof Padchat
  */
  async login(type = 'qrcode', data = {}) {
    const _data = {
      loginType: '',
      wxData   : data.wxData || null,
    }
    if (!loginType[type]) {
      throw new Error('login type error!')
    }

    switch (type) {
      case loginType.token:
      case loginType.request:
        if (!data.token || !data.wxData) {
          throw new Error('login data error!')
        }
        _data.token = data.token || null
        break
      case loginType.phone:
        if (!data.phone) {
          // code
          throw new Error('login data error!')
        }
        _data.phone = data.phone
        _data.code  = data.code
        break
      case loginType.user:
        if (!data.username || !data.password) {
          throw new Error('login data error!')
        }
        _data.username = data.username
        _data.password = data.password
        break
      default:
        break
    }
    _data.loginType = loginType[type]
    return await this.sendCmd('login', _data)
  }

  /**
  * 获取设备62数据
  *
  * **WARN: ** 如果使用62数据进行登陆，再获取到的62数据是无效的，一定不要用。
  * 事实上，只要你有一次登陆成功，以后一直用这个62数据，不需要更换。
  *
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    error: '', success: true,
    data :
      {
        wxData: '62xxxxx'  //设备62数据
      }
  }
  * ```
  * @memberof Padchat
  */
  async getWxData() {
    return await this.sendCmd('getWxData', {})
  }

  /**
  * 获取二次登陆数据
  *
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    error  : '',
    success: true,
    data   :
      {
        message: '',
        status : 0,
        token  : 'xxxx',   //二次登陆token
        uin    : 14900000  //微信号uin，唯一值
      }
  }
  * ```
  * @memberof Padchat
  */
  async getLoginToken() {
    return await this.sendCmd('getLoginToken', {})
  }

  /**
  * 获取微信号信息
  *
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    error  : '',
    success: true,
    data:
      {
        userName: 'wxid_xxxx',   //微信号id，注意不一定是微信号，全局唯一
        uin     : 101234567      //微信号uin，全局唯一
      }
  }
  * ```
  * @memberof Padchat
  */
  async getMyInfo() {
    return await this.sendCmd('getMyInfo')
  }

  /**
  * 同步消息
  *
  * 使用此接口手动触发同步消息，一般用于刚登陆后调用，可立即开始同步消息。
  * 否则会在有新消息时才开始同步消息。
  *
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * @memberof Padchat
  */
  async syncMsg() {
    return await this.sendCmd('syncMsg')
  }

  /**
  * 同步通讯录
  *
  * 使用此接口可以触发同步通讯录，如果设置`reset`为`true`，则会先重置同步状态。
  * 重置同步状态后，会再次接收到前一段时间内的消息推送，需自行处理过滤。
  *
  * @param {boolean} [reset=false] 是否重置同步状态
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * @memberof Padchat
  */
  async syncContact(reset = false) {
    return await this.sendCmd('syncContact', {
      reset
    })
  }

  /**
  * 退出登录
  *
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * @memberof Padchat
  */
  async logout() {
    return await this.sendCmd('logout', {})
  }

  /**
  * 发送文字信息
  *
  * @param {string} toUserName - 接收者的wxid
  * @param {string} content - 内容文本
  * @param {Array<string>} [atList=[]] - 向群内发信息时，要@的用户wxid数组
  * FIXME: 无法At用户
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    error: '', success: true,
    data : {
      message: '',
      msgId  : '5172746684759824075',
      status : 0
    }
  }
  * ```
  *  @memberof Padchat
  */
  async sendMsg(toUserName, content, atList = []) {
    return await this.sendCmd('sendMsg', {
      toUserName,
      content,
      atList,
    })
  }

  /**
  * 群发文字信息
  *
  * FIXME: 此接口有问题，暂停使用
  *
  * @param {Array<string>} [userList=[]] - 接收者wxid数组
  * @param {string} content - 内容文本
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * @memberof Padchat
  */
  async massMsg(userList = [], content) {
    return new Error('此接口存在问题，停用!')
    // return await this.sendCmd('massMsg', {
    //   userList,
    //   content,
    // })
  }

  /**
  * 发送App消息
  *
  * @param {string} toUserName - 接收者的wxid
  * @param {object} object - 内容文本
  * @param {object} [object.appid] - appid，忽略即可
  * @param {object} [object.sdkver] - sdk版本，忽略即可
  * @param {object} [object.title] - 标题
  * @param {object} [object.des] - 描述
  * @param {object} [object.url] - 链接url
  * @param {object} [object.thumburl] - 缩略图url
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    error: '', success: true,
    data : {
      message: '',
      msgId  : '2195811529497100215',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async sendAppMsg(toUserName, object) {
    const content = Helper.structureXml(object)
    return await this.sendCmd('sendAppMsg', {
      toUserName,
      content,
    })
  }

  /**
  * 分享名片
  *
  * @param {string} toUserName - 接收者的wxid
  * @param {string} content - 内容文本
  * @param {string} userId - 被分享人wxid
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    error: '', success: true,
    data : {
      message: '',
      msgId  : '1797099903789182796',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async shareCard(toUserName, content, userId) {
    return await this.sendCmd('shareCard', {
      toUserName,
      content,
      userId,
    })
  }

  /**
  * 发送图片消息
  *
  * @param {string} toUserName - 接收者的wxid
  * @param {Buffer|string} file - 图片Buffer数据或base64
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    error: '', success: true,
    data : {
      message: '',
      msgId  : '1797099903789182796',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async sendImage(toUserName, file) {
    if (file instanceof Buffer) {
      file = file.toString('base64')
    }
    return await this.sendCmd('sendImage', {
      toUserName,
      file,
    })
  }

  /**
  * 发送语音消息
  * 注意：只能发送silk格式的语音文件
  *
  * @param {string} toUserName - 接收者的wxid
  * @param {Buffer|string} file - 语音Buffer数据或base64
  * @param {number} time - 语音时间，单位为毫秒
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    error: '', success: true,
    data : {
      data   : 2490,                   //语音文件尺寸
      message: '',
      msgId  : '136722815749654341',
      size   : 0,
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async sendVoice(toUserName, file, time = 0) {
    if (file instanceof Buffer) {
      file = file.toString('base64')
    }
    return await this.sendCmd('sendVoice', {
      toUserName,
      file,
      time: time * 1
    })
  }

  /**
  * 获取消息原始图片
  *
  * 在push事件中收到的data数据是缩略图图片数据，使用本接口获取原图数据
  *
  * @param {object} rawMsgData - 推送的消息结构体，即`push`事件中收到的Object
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        image  : 'base64_xxxx',   //base64编码的原图数据
        message: '',
        size   : 8139,            //图片数据尺寸
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async getMsgImage(rawMsgData) {
    return await this.sendCmd('getMsgImage', {
      rawMsgData,
    })
  }

  /**
  * 获取消息原始视频
  *
  * 在push事件中只获得推送通知，不包含视频数据，需要使用本接口获取视频文件数据
  *
  * @param {object} rawMsgData - 推送的消息结构体，即`push`事件中收到的Object
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        message: '',
        size   : 160036,        //视频数据尺寸
        status : 0,
        video  : 'base64_xxxx'  //base64编码的视频数据
      }
  }
  * ```
  * @memberof Padchat
  */

  async getMsgVideo(rawMsgData) {
    return await this.sendCmd('getMsgVideo', {
      rawMsgData,
    })
  }

  /**
  * 获取消息语音数据
  *
  * 这个接口获取到的与push事件中接收到的数据一致，是base64编码的silk格式语音数据
  *
  * BUG: 超过60Kb的语音数据，只能拉取到60Kb，也就是说大约36~40秒以上的语音会丢失后边部分语音内容
  *
  * @param {object} rawMsgData - 推送的消息结构体，即`push`事件中收到的Object
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        message: '',
        size   : 2490,          //语音数据尺寸
        status : 0,
        voice  : 'base64_xxxx'  //base64编码的语音数据
      }
  }
  * ```
  * @memberof Padchat
  */
  async getMsgVoice(rawMsgData) {
    return await this.sendCmd('getMsgVoice', {
      rawMsgData,
    })
  }

  /**
  * 创建群
  *
  * 注意：如果有用户存在问题不能进群，则会建群失败。
  * 但判断是否成功应以`userName`字段
  *
  * @param {string[]} userList - 用户wxid数组
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        message : 'Everything is OK',    //操作结果提示，失败为`MemberList are wrong`
        status  : 0,
        userName: '5658541000@chatroom'  //如果建群成功，则返回群id
      }
  }
  * ```
  * @memberof Padchat
  */
  async createRoom(userList) {
    return await this.sendCmd('createRoom', {
      userList,
    })
  }

  /**
  * 获取群成员信息
  *
  * @param {string} groupId - 群id
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        chatroomId: 700000001,
        count     : 3,           //群成员数量
        member    :              //群成员列表
         [{
            bigHead         : 'http://wx.qlogo.cn/xxx/0',     //大头像url
            chatroomNickName: '',                             //群内昵称
            invitedBy       : 'binsee',                       //进群邀请人
            nickName        : '小木匠',                          //昵称
            smallHead       : 'http://wx.qlogo.cn/xxx/132',   //小头像url
            userName        : 'wxid_xxxx'                     //wxid
          }],
        message : '',
        status  : 0,
        userName: '5658541000@chatroom'  //群id
      }
  }
  * ```
  * @memberof Padchat
  */
  async getRoomMembers(groupId) {
    return await this.sendCmd('getRoomMembers', {
      groupId,
    })
  }

  /**
  * 添加群成员
  *
  * @param {string} groupId - 群id
  * @param {string} userId - 用户wxid
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: 'Everything is OK',   //失败为`MemberList are wrong`
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async addRoomMember(groupId, userId) {
    return await this.sendCmd('addRoomMember', {
      groupId,
      userId,
    })
  }

  /**
  * 邀请群成员
  * 会给对方发送一条邀请消息，无法判断对方是否真的接收到
  *
  * @param {string} groupId - 群id
  * @param {string} userId - 用户wxid
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async inviteRoomMember(groupId, userId) {
    return await this.sendCmd('inviteRoomMember', {
      groupId,
      userId,
    })
  }

  /**
  * 删除群成员
  *
  * @param {string} groupId - 群id
  * @param {string} userId - 用户wxid
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async deleteRoomMember(groupId, userId) {
    return await this.sendCmd('deleteRoomMember', {
      groupId,
      userId,
    })
  }

  /**
  * 退出群
  *
  * @param {string} groupId - 群id
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async quitRoom(groupId) {
    return await this.sendCmd('quitRoom', {
      groupId,
    })
  }

  /**
  * 设置群公告
  *
  * @param {string} groupId - 群id
  * @param {string} content - 群公告内容
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async setRoomAnnouncement(groupId, content) {
    return await this.sendCmd('setRoomAnnouncement', {
      groupId,
      content,
    })
  }

  /**
  * 设置群名称
  *
  * @param {string} groupId - 群id
  * @param {string} content - 群名称
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async setRoomName(groupId, content) {
    return await this.sendCmd('setRoomName', {
      groupId,
      content,
    })
  }

  /**
  * 获取微信群二维码
  *
  * @param {string} groupId - 群id
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        footer : '该二维码7天内(4月13日前)有效，重新进入将更新',
        message: '',
        qrCode : '',                            //进群二维码图片base64
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async getRoomQrcode(groupId) {
    return await this.sendCmd('getRoomQrcode', {
      groupId,
      style: 0,
    })
  }

  /**
  * 获取用户/群信息
  *
  * @param {string} userId - 用户wxid/群id
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  *
  * 微信用户/公众号返回：
  *
  * ```
  {
    success: true,
    data   :
      {
        bigHead        : 'http://wx.qlogo.cn/xxx/0',     //大头像url
        city           : 'mesa',                         //城市
        country        : 'CN',                           //国家
        intro          : '',                             //简介（公众号主体）
        label          : '',                             //（标签）
        message        : '',
        nickName       : '杉木',                           //昵称
        provincia      : 'Henan',                        //省份
        pyInitial      : 'SM',                           //昵称拼音简写
        quanPin        : 'shamu',                        //昵称拼音
        remark         : '',                             //备注
        remarkPyInitial: '',                             //备注拼音简写
        remarkQuanPin  : '',                             //备注拼音
        sex            : 1,                              //性别：1男2女
        signature      : '签名',                           //个性签名
        smallHead      : 'http://wx.qlogo.cn/xxx/132',   //小头像url
        status         : 0,
        stranger       : 'v1_xxx@stranger',              //用户v1码，从未加过好友则为空
        ticket         : 'v2_xxx@stranger',              //用户v2码，如果非空则为单向好友(非对方好友)
        userName       : 'binxxx'                        //用户wxid
      }
  }
  * ```
  *
  * 微信群返回:
  *
  * ```
  {
    success: true,
    data   : {
      city           : '',
      country        : '',
      intro          : '',
      label          : '',
      member         : [],                            //群成员wxid数组
      message        : '',
      provincia      : '',
      remark         : '',
      sex            : 0,
      signature      : '',
      status         : 0,
      stranger       : 'v1_xxx@stranger',
      ticket         : '',
      bigHead        : '',
      chatroomId     : 700001234,
      chatroomOwner  : 'wxid_xxx',
      maxMemberCount : 500,                           //群最大人数
      memberCount    : 377,                           //群当前人数
      nickName       : 'Wechaty Developers\' Home',   //群名称
      pyInitial      : 'WECHATYDEVELOPERSHOME',
      quanPin        : 'WechatyDevelopersHome',
      remarkPyInitial: '',
      remarkQuanPin  : '',
      smallHead      : 'http://wx.qlogo.cn/xxx/0',    //群头像url
      userName       : '1234567890@chatroom'
    }
  }
  * ```
  * @memberof Padchat
  */
  async getContact(userId) {
    return await this.sendCmd('getContact', {
      userId,
    })
  }

  /**
  * 搜索用户
  * 可用此接口来判断是否已经加对方为好友
  *
  * @param {string} userId - 用户wxid
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        bigHead  : 'http://wx.qlogo.cn/xxx/0',     //大头像url
        city     : 'mesa',                         //城市
        country  : 'CN',                           //国家
        message  : '',
        nickName : '杉木',                           //昵称
        provincia: 'Henan',                        //省份
        pyInitial: 'SM',                           //昵称拼音简写
        quanPin  : 'shamu',                        //昵称拼音
        sex      : 1,                              //性别：1男2女
        signature: '签名',                           //个性签名
        smallHead: 'http://wx.qlogo.cn/xxx/132',   //小头像url
        status   : 0,
        stranger : 'v1_xxx@stranger',              //好友为空，非好友显示v2码
        userName : 'binxxx'                        //是自己好友显示wxid，非好友为v1码
      }
  }
  * ```
  * @memberof Padchat
  */
  async searchContact(userId) {
    return await this.sendCmd('searchContact', {
      userId,
    })
  }

  /**
  * 删除好友
  *
  * @param {string} userId - 用户wxid
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async deleteContact(userId) {
    return await this.sendCmd('deleteContact', {
      userId,
    })
  }

  /**
  * 获取用户二维码
  * 仅限获取自己的二维码，无法获取其他人的二维码
  *
  * @param {string} userId - 用户wxid
  * @param {Number} style - 二维码风格。可用范围0-3
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        footer : '',
        message: '',
        qrCode : '',   //二维码图片base64
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async getContactQrcode(userId, style = 0) {
    return await this.sendCmd('getUserQrcode', {
      userId,
      style,
    })
  }

  /**
  * 通过好友验证
  *
  * @param {string} stranger - 用户stranger数据
  * @param {string} ticket - 用户ticket数据
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async acceptUser(stranger, ticket) {
    return await this.sendCmd('acceptUser', {
      stranger,
      ticket,
    })
  }

  /**
  * 添加好友
  *
  * @param {string} stranger - 用户stranger数据
  * @param {string} ticket - 用户ticket数据
  * @param {Number} type - 添加好友途径
  × 值 | 说明
  × ----|----
  x 0 | 通过微信号搜索
  × 1 | 搜索QQ号
  x 3 | 通过微信号搜索
  × 4 | 通过QQ好友添加
  × 8 | 通过群聊
  × 12 | 来自QQ好友
  × 14 | 通过群聊
  × 15 | 通过搜索手机号
  × 17 | 通过名片分享           //未验证
  × 22 | 通过摇一摇打招呼方式    //未验证
  × 25 | 通过漂流瓶             //未验证
  × 30 | 通过二维码方式         //未验证
  * @param {string} [content=''] - 验证信息
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: '',
      status : 0    //如果对方设置了验证，会返回-44
    }
  }
  * ```
  * @memberof Padchat
  */
  async addContact(stranger, ticket, type = 3, content = '') {
    return await this.sendCmd('addContact', {
      stranger,
      ticket,
      type,
      content,
    })
  }

  /**
  * 打招呼
  * 如果已经是好友，会收到由系统自动发送，来自对方的一条文本信息
  * “xx已通过你的朋友验证请求，现在可以开始聊天了”
  *
  * @param {string} stranger - 用户stranger数据
  * @param {string} ticket - 用户ticket数据
  * @param {string} content - 打招呼内容
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async sayHello(stranger, ticket, content = '') {
    return await this.sendCmd('sayHello', {
      stranger,
      ticket,
      content,
    })
  }

  /**
  * 设置备注
  *
  * @param {string} userId - 用户wxid
  * @param {string} remark - 备注名称
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async setRemark(userId, remark) {
    return await this.sendCmd('setRemark', {
      userId,
      remark,
    })
  }

  /**
  * 设置头像
  *
  * @param {Buffer|string} file - 图片Buffer数据或base64
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
    {
      success: true,
      data   :
        {
          bigHead  : 'http://wx.qlogo.cn/mmhead/ver_1/xxx/0',
          data     : 1527,                                        //图片文件尺寸
          message  : '',
          size     : 1527,                                        //图片文件尺寸
          smallHead: 'http://wx.qlogo.cn/mmhead/ver_1/xxx/132',
          status   : 0
        }
    }
  * ```
  * @memberof Padchat
  */
  async setHeadImg(file) {
    if (file instanceof Buffer) {
      file = file.toString('base64')
    }
    return await this.sendCmd('setHeadImg', {
      file,
    })
  }

  /** 朋友圈系列接口 */

  /**
  * 上传图片到朋友圈
  * NOTE: 此接口只能上传图片，并不会将图片发到朋友圈中
  *
  * @param {Buffer|string} file - 图片Buffer数据或base64
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
    {
      success: true,
      data   :
        {
          bigHead  : 'http://mmsns.qpic.cn/mmsns/xxx/0',
          data     : 1527,                                   //图片文件尺寸
          message  : '',
          size     : 1527,                                   //图片文件尺寸
          smallHead: 'http://mmsns.qpic.cn/mmsns/xxx/150',
          status   : 0
        }
    }
  * ```
  * @memberof Padchat
  */
  async snsUpload(file) {
    if (file instanceof Buffer) {
      file = file.toString('base64')
    }
    return await this.sendCmd('snsUpload', {
      file,
    })
  }

  /**
  * 操作朋友圈
  *
  * @param {string} momentId - 朋友圈信息id
  * @param {Number} type - 操作类型，1为删除朋友圈，4为删除评论，5为取消赞
  * @param {Number} commentId - 操作类型，当type为4时，对应删除评论的id，其他状态为0
  * @param {Number} commentType - 操作类型，当删除评论时可用，需与评论type字段一致
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async snsobjectOp(momentId, type, commentId, commentType = 2) {
    return await this.sendCmd('snsobjectOp', {
      momentId,
      type,
      commentId,
      commentType,
    })
  }

  /**
  * 发朋友圈
  *
  * @param {string} content - 文本内容或`Timelineobject`结构体文本
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        data:
          {
            create_time: 1523015689,
            description:              //朋友圈信息xml结构体文本
            '<Timelineobject><id>12775981595019653292</id><username>wxid_xxx</username><createTime>1523015689</createTime><contentDesc>来自代码发的朋友圈</contentDesc><contentDescShowType>0</contentDescShowType><contentDescScene>3</contentDescScene><private>0</private><sightFolded>0</sightFolded><appInfo><id></id><version></version><appName></appName><installUrl></installUrl><fromUrl></fromUrl><isForceUpdate>0</isForceUpdate></appInfo><sourceUserName></sourceUserName><sourceNickName></sourceNickName><statisticsData></statisticsData><statExtStr></statExtStr><Contentobject><contentStyle>2</contentStyle><title></title><description></description><mediaList></mediaList><contentUrl></contentUrl></Contentobject><actionInfo><appMsg><messageAction></messageAction></appMsg></actionInfo><location poiClassifyId="" poiName="" poiAddress="" poiClassifyType="0" city=""></location><publicUserName></publicUserName><streamvideo><streamvideourl></streamvideourl><streamvideothumburl></streamvideothumburl><streamvideoweburl></streamvideoweburl></streamvideo></Timelineobject>',
            id       : '12775981595019653292',   //朋友圈信息id
            nick_name: '小木匠',
            user_name: 'wxid_xxxx'
          },
        message: '',
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async snsSendMoment(content) {
    return await this.sendCmd('snsSendMoment', {
      content,
    })
  }

  /**
  * 查看用户朋友圈
  *
  * @param {string} userId - 用户wxid
  * @param {string} [momentId=''] - 朋友圈信息id
  * 首次传入空即获取第一页，以后传入上次拉取的最后一条信息id
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        count: 1,
        data :     //朋友圈信息结构数组（无评论和点赞数据）
          [{
            create_time: 1523015689,
            description: '<Timelineobject><id>12775981595019653292</id><username>wxid_xxx</username><createTime>1523015689</createTime><contentDesc>来自代码发的朋友圈</contentDesc><contentDescShowType>0</contentDescShowType><contentDescScene>3</contentDescScene><private>0</private> <sightFolded>0</sightFolded> <appInfo><id></id><version></version><appName></appName><installUrl></installUrl><fromUrl></fromUrl><isForceUpdate>0</isForceUpdate></appInfo> <sourceUserName></sourceUserName> <sourceNickName></sourceNickName> <statisticsData></statisticsData> <statExtStr></statExtStr> <Contentobject><contentStyle>2</contentStyle><title></title><description></description><mediaList></mediaList><contentUrl></contentUrl></Contentobject> <actionInfo><appMsg><messageAction></messageAction></appMsg></actionInfo> <location poiClassifyId="" poiName="" poiAddress="" poiClassifyType="0" city=""></location> <publicUserName></publicUserName> <streamvideo><streamvideourl></streamvideourl><streamvideothumburl></streamvideothumburl><streamvideoweburl></streamvideoweburl></streamvideo></Timelineobject> ',
            id         : '12775981595019653292',
            nick_name  : '小木匠',
            user_name  : 'wxid_xxx'
          }],
        message: '',
        page   : '81cb2ad01ebc219f',
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async snsUserPage(userId, momentId = '') {
    return await this.sendCmd('snsUserPage', {
      userId,
      momentId,
    })
  }

  /**
  * 查看朋友圈动态
  *
  * @param {string} [momentId=''] - 朋友圈信息id
  * 首次传入空即获取第一页，以后传入上次拉取的最后一条信息id
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        count: 1,
        data :     //朋友圈信息结构数组（无评论和点赞数据）
          [{
            create_time: 1523015689,
            description: '<Timelineobject><id>12775981595019653292</id><username>wxid_xxx</username><createTime>1523015689</createTime><contentDesc>来自代码发的朋友圈</contentDesc><contentDescShowType>0</contentDescShowType><contentDescScene>3</contentDescScene><private>0</private> <sightFolded>0</sightFolded> <appInfo><id></id><version></version><appName></appName><installUrl></installUrl><fromUrl></fromUrl><isForceUpdate>0</isForceUpdate></appInfo> <sourceUserName></sourceUserName> <sourceNickName></sourceNickName> <statisticsData></statisticsData> <statExtStr></statExtStr> <Contentobject><contentStyle>2</contentStyle><title></title><description></description><mediaList></mediaList><contentUrl></contentUrl></Contentobject> <actionInfo><appMsg><messageAction></messageAction></appMsg></actionInfo> <location poiClassifyId="" poiName="" poiAddress="" poiClassifyType="0" city=""></location> <publicUserName></publicUserName> <streamvideo><streamvideourl></streamvideourl><streamvideothumburl></streamvideothumburl><streamvideoweburl></streamvideoweburl></streamvideo></Timelineobject> ',
            id         : '12775981595019653292',
            nick_name  : '小木匠',
            user_name  : 'wxid_xxx'
          }],
        message: '',
        page   : '81cb2ad01ebc219f',
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async snsTimeline(momentId = '') {
    return await this.sendCmd('snsTimeline', {
      momentId,
    })
  }

  /**
  * 获取朋友圈信息详情
  *
  * @param {string} momentId - 朋友圈信息id
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      data   : {},   //朋友圈信息结构
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async snsGetObject(momentId) {
    return await this.sendCmd('snsGetObject', {
      momentId,
    })
  }

  /**
  * 评论朋友圈
  *
  * @param {string} userId - 用户wxid
  * @param {string} momentId - 朋友圈信息id
  * @param {string} content - 内容文本
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      data   : {},   //朋友圈信息结构
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */

  async snsComment(userId, momentId, content) {
    return await this.sendCmd('snsComment', {
      userId,
      momentId,
      content,
    })
  }

  /**
  * 朋友圈点赞
  *
  * @param {string} userId - 用户wxid
  * @param {string} momentId - 朋友圈信息id
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      data   : {},   //朋友圈信息结构
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async snsLike(userId, momentId) {
    return await this.sendCmd('snsLike', {
      userId,
      momentId,
    })
  }

  /** 收藏系列接口 */

  /**
  * 同步收藏消息
  *
  * @param {string} [favKey=''] - 同步key，首次不用传入
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        continue: 0,
        data    :     //收藏消息列表，如果没有则为null
          [
            {
              flag: 0,            //首次标志，0为有效，1为已取消收藏
              id  : 3,            //收藏id
              seq : 652265243,    //收藏随机值
              time: 1515042008,   //收藏时间
              type: 5             //收藏类型：1文本;2图片;3语音;4视频;5图文消息
            }
          ],
        key    : 'kzTKsdjD6PM0bbQv+oP7vQ==',   //下次的同步key，类似分页
        message: '',
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async syncFav(favKey = '') {
    return await this.sendCmd('syncFav', {
      favKey,
    })
  }

  /**
  * 添加收藏
  *
  * @param {string} content - 内容文本
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * @memberof Padchat
  */
  async addFav(content) {
    return await this.sendCmd('addFav', {
      content,
    })
  }

  /**
  * 获取收藏消息详情
  *
  * @param {Number} favId - 收藏id
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        data:
          [
            , {
              flag  : 0,   //收藏状态：0为有效，1为无效(已删除)
              id    : 3,   //收藏id，如果为0则为无效收藏
              object:      //收藏对象结构体文本
                '<favitem type="5"><desc>DaoCloud 首席架构师王天青：下一代应用转型之道、术、器</desc><source sourcetype="1" sourceid="5353367357590009973"><fromusr>gh_4b6a20bcdd8b</fromusr><tousr>wxid_xxx</tousr><msgid>5353367357590009973</msgid><link>http://mp.weixin.qq.com/s?__biz=MzA5MzA2Njk5OA==&amp;mid=2650096972&amp;idx=1&amp;sn=8707378d0c0bdc0d14d1ac93972c5862&amp;chksm=886266d5bf15efc386050508a2cafb1adb806196f40f4f1bde8e944926c7fb6c6e54a14875c7&amp;scene=0#rd</link><brandid>gh_4b6a20bcdd8b</brandid></source><datalist count="1"><dataitem datatype="5" dataid="1e241bc540e4d5da8f0e580fbb2f7c1a" dataillegaltype="0" datasourceid="5353367357590009973"><datatitle>DaoCloud 首席架构师王天青：下一代应用转型之道、术、器</datatitle><datadesc>DaoCloud 受邀出席第13届信息化领袖峰会，立足于 DaoCloud 为传统企业数字化转型旅途中的丰富实践，与大家共话《下一代应用转型之道、术、器》，探讨如何“用新技术原力现代化你的企业应用”。</datadesc><dataext>http://mmbiz.qpic.cn/mmbiz_jpg/icGWTH9VkFq315HbKuKtWeWlcVDNPAswdhYA0kIskz0GcEQp6nJetC2aSBNfpibp1wKNHf8kYjUibkCF6SgbMIocw/640?wxtype=jpeg&amp;wxfrom=0</dataext></dataitem></datalist><weburlitem><pagethumb_url>http://mmbiz.qpic.cn/mmbiz_jpg/icGWTH9VkFq315HbKuKtWeWlcVDNPAswdhYA0kIskz0GcEQp6nJetC2aSBNfpibp1wKNHf8kYjUibkCF6SgbMIocw/640?wxtype=jpeg&amp;wxfrom=0</pagethumb_url></weburlitem><recommendtaglist></recommendtaglist></favitem>',
              //文本消息收藏结构
              // '<favitem type="1"><desc>接收到你发送的内容了!&#x0A;&#x0A;原内容：sync</desc><source sourcetype="1" sourceid="5451059336571949850"><fromusr>wxid_xxx</fromusr><tousr>binsee</tousr><msgid>5451059336571949850</msgid></source><taglist><tag>ted</tag><tag>hj</tag></taglist></favitem>'
              // 视频
              // '<favitem type="2"><source sourcetype="1" sourceid="786100356842168336"><fromusr>wxid_xxx</fromusr><tousr>4674258153@chatroom</tousr><realchatname>wxid_xxx</realchatname><msgid>786100356842168336</msgid></source><datalist count="1"><dataitem datatype="2" dataid="2b4d63555959bd7ffb62722e8c186030" dataillegaltype="0" datasourceid="786100356842168336"><cdn_thumburl>304c02010004453043020100020408eddd7c02030f4fed020419a0360a02045ac9271704206162313437386338616237383833333266336564343335666166363435646331020227110201000400</cdn_thumburl><cdn_dataurl>304c02010004453043020100020408eddd7c02030f4fed0204b94c716402045ac9271704203865383031656465633132333661303939346365663837643165316539363663020227110201000400</cdn_dataurl><cdn_thumbkey>ab1478c8ab788332f3ed435faf645dc1</cdn_thumbkey><cdn_datakey>8e801edec1236a0994cef87d1e1e966c</cdn_datakey><fullmd5>8e801edec1236a0994cef87d1e1e966c</fullmd5><head256md5>324b6cffbba04142bfabf5cdd0621b40</head256md5><fullsize>92377</fullsize><thumbfullmd5>ab1478c8ab788332f3ed435faf645dc1</thumbfullmd5><thumbhead256md5>4fcedfae8fcaa571504c5fd9f2abfa0a</thumbhead256md5><thumbfullsize>5658</thumbfullsize><datadesc></datadesc><datatitle></datatitle></dataitem></datalist><recommendtaglist></recommendtaglist></favitem>'
              // 语音
              // '<favitem type=\'3\'><source sourcetype=\'1\' sourceid=\'3687245278820959898\'><fromusr>wxid_xxx</fromusr><tousr>4674258153@chatroom</tousr><realchatname>wxid_xxx</realchatname><msgid>3687245278820959898</msgid></source><datalist count=\'1\'><dataitem datatype=\'3\' dataid=\'b1b222bcf285270772bf8698b2933bc7\' dataillegaltype=\'0\' datasourceid=\'3687245278820959898\'><datafmt>silk</datafmt><cdn_dataurl>304c02010004453043020100020408eddd7c02030f4fed020419a2360a02045ac9271104203064643962326231623464663936626433383831313136646235333831343537020227110201000400</cdn_dataurl><cdn_datakey>0dd9b2b1b4df96bd3881116db5381457</cdn_datakey><duration>2465</duration><fullmd5>0dd9b2b1b4df96bd3881116db5381457</fullmd5><head256md5>d348a2942af6d188100855d48dc75373</head256md5><fullsize>4186</fullsize></dataitem></datalist></favitem>'
              seq   : 652265243,
              status: 0,           //0为有效收藏，1为无效收藏
              time  : 1515042008
            }
          ],
        message: '',
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async getFav(favId) {
    return await this.sendCmd('getFav', {
      favId,
    })
  }

  /**
  * 删除收藏
  *
  * @param {Number} favId - 收藏id
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        data:
          [
            {
              flag  : 0,
              id    : 0,
              object: '',
              seq   : 0,
              status: 1,    //返回删除的收藏id
              time  : 0
            },
          ],
        message: '',
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async deleteFav(favId) {
    return await this.sendCmd('deleteFav', {
      favId,
    })
  }

  /** 标签系列接口 */

  /**
  * 获取所有标签
  *
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        label:   //标签列表
          [{
            id  : 1,      //标签id
            name: '测试标签'  //标签名称
          }],
        message: '',
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async getLabelList() {
    return await this.sendCmd('getLabelList', {})
  }

  /**
  * 添加标签
  *
  * @param {string} label - 标签名称
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async addLabel(label) {
    return await this.sendCmd('addLabel', {
      label,
    })
  }

  /**
  * 删除标签
  *
  * @param {string} labelId - 标签id，注意是id是string类型
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async deleteLabel(labelId) {
    return await this.sendCmd('deleteLabel', {
      labelId,
    })
  }

  /**
  * 设置用户标签
  *
  * @param {string} userId - 用户wxid
  * @param {string} labelId - 标签id
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async setLabel(userId, labelId) {
    return await this.sendCmd('setLabel', {
      userId,
      labelId,
    })
  }

  /** 转账及红包接口 */

  /**
  * 查看转账消息
  *
  * @param {object} rawMsgData - 推送的消息结构体，即`push`事件中收到的Object
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        external:
          {
            retcode       : '0',
            retmsg        : 'ok',
            fee           : 20,                      //转账金额(单位为分)
            transStatus   : 2000,                    //状态:2000未收款;2001已收款
            feeType       : '1',
            payTime       : 1523176700,
            modifyTime    : 0,
            refundBankType: 'BANK',
            payerName     : 'binsee',
            receiverName  : 'wxid_8z66rux8lysr22',
            statusDesc    : '待确认收款',                 //收款描述
            // '已收钱'       //已收款
            // '待%s确认收款' //等待对方收款
            // '%s已收钱'     //对方已收款
            statusSupplementary: '',   //状态补充信息
            // 未领取：
            // '1天内未确认，将退还给对方。<_wc_custom_link_ href="weixin://wcpay/transfer/rebacksendmsg">立即退还</_wc_custom_link_>',
            delayConfirmFlag: 0,
            //
            // 已领取：
            // '<_wc_custom_link_ href="weixin://wcpay/transfer/watchbalance">查看零钱</_wc_custom_link_>'
            //
            // 等待对方收款:
            // '1天内朋友未确认，将退还给你。<_wc_custom_link_ href="weixin://wcpay/transfer/retrysendmsg">重发转账消息</_wc_custom_link_>'
            isPayer: false
            //
            // 对方已收款为空
          },
        message: '',
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async queryTransfer(rawMsgData) {
    return await this.sendCmd('queryTransfer', {
      rawMsgData,
    })
  }

  /**
  * 接受转账
  *
  * @param {object} rawMsgData - 推送的消息结构体，即`push`事件中收到的Object
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        external:
          {
            fee     : 20,          //转账金额(单位为分)
            payer   : '085exxx',   //付款id
            receiver: '085exxx',   //接收id
            retcode : '0',
            retmsg  : 'ok',
            feeType : '1'
          },
        message: '',
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async acceptTransfer(rawMsgData) {
    return await this.sendCmd('acceptTransfer', {
      rawMsgData,
    })
  }

  /**
  * 接收红包
  *
  * @param {object} rawMsgData - 推送的消息结构体，即`push`事件中收到的Object
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        external:   //扩展数据结构
          {
            retcode         : 0,
            retmsg          : 'ok',
            sendId          : '10000xxx',      //发送id
            wishing         : '发3个红包',         //红包祝语
            isSender        : 0,               //是否自己发送
            receiveStatus   : 0,               //接收状态:0未接收;2已领取
            hbStatus        : 3,               //红包状态：3未领取完;4已领取完毕
            statusMess      : '发了一个红包，金额随机',   //
            hbType          : 1,               //红包类型
            watermark       : '',
            sendUserName    : 'binsee',        //发送者wxid
            timingIdentifier: 'C6E370xxx',
            agreeDuty       :                  //未知含义，非必然
              {
                title                 : '',
                serviceProtocolWording: '',
                serviceProtocolUrl    : '',
                buttonWording         : '',
                delayExpiredTime      : 0,
                agreedFlag            : 1
              }
          },
        key    : 'C6E370xxx',   //红包key，用于领取红包
        message: '',
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async receiveRedPacket(rawMsgData) {
    return await this.sendCmd('receiveRedPacket', {
      rawMsgData,
    })
  }

  /**
  * 查看红包信息
  * NOTE: 如果是别人发的红包，未领取且未领取完毕时，无法取到红包信息
  *
  * @param {object} rawMsgData - 推送的消息结构体，即`push`事件中收到的Object
  * @param {Number} [index=0] - 列表索引。
  * 每页11个，查看第二页11，查看第三页22，以此类推
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * 未先接收红包返回结果：
  * ```
  {
    success: true,
    data   :
      {
        external:   //扩展数据
          {
            retcode        : 0,
            retmsg         : 'ok',
            operationHeader: [0],
            record         : [0]
          },
        message: '',
        status : 0
      }
  }
  * ```
  *
  * 接收红包后查询结果：
  * ```
  {
    success: true,
    data   :
      {
        external:
          {
            retcode        : 0,
            retmsg         : 'ok',
            recNum         : 2,            //已领取数
            totalNum       : 2,            //红包个数
            totalAmount    : 100,          //红包总金额(单位为分)
            sendId         : '10000xxx',   //发送id
            amount         : 85,           //领取到金额(单位为分)
            wishing        : 'Hello!',     //红包祝语
            isSender       : 1,            //是否是自己发送的
            receiveId      : '10000xxx',   //接收id
            hasWriteAnswer : 1,            //是否已写回复
            operationHeader: [],           //未知
            hbType         : 1,            //红包类型
            isContinue     : 0,            //是否已领取完
            hbStatus       : 3,            //红包状态：2未领取;3未领取完;4已领取完毕
            // 普通红包或单发红包是2，随机红包是3或4
            receiveStatus: 2,        //接收状态:0未接收;2已领取
            statusMess   : '成功领到',   //状态提示，未领取为空
            headTitle    : '',       //红包头部标题
            // '已领取1/2个，共0.01/0.02元'   //自己发的红包未领取完时
            // '2个红包共1.00元，15秒被抢光'   //自己发的红包未领取完时
            // '领取2/3个'                   //别人发的红包未领取完时
            // '2个红包，42秒被抢光'          //别人发的红包未领取完时
            canShare : 0,     //是否可分享
            hbKind   : 1,     //红包种类
            recAmount: 100,   //已领取金额(单位为分)
            record   :
              [
                {
                  receiveAmount: 85,             //领取金额(单位为分)
                  receiveTime  : '1523169782',   //领取时间戳字符串
                  answer       : '',             //领取者留言，仅查询接口有效
                  receiveId    : '10000xxx',
                  state        : 1,
                  gameTips     : '手气最佳',         //仅红包领取完毕时，手气最佳者有此字段
                  receiveOpenId: '10000xxx',
                  userName     : 'wxid_xxx'      //领取者wxid
                },
                {
                  receiveAmount: 15,
                  receiveTime  : '1523174612',
                  answer       : '谢谢红包',
                  receiveId    : '1000039501001804086017706218338',
                  state        : 1,
                  receiveOpenId: '1000039501001804086017706218338',
                  userName     : 'binsee'
                },
              ],
            operationTail:   //操作提示：仅自己发的红包有效
              {
                name   : '未领取的红包，将于24小时后发起退款',
                type   : 'Text',
                content: '',
                enable : 1,
                iconUrl: '',
                ossKey : 4294967295
              },
            atomicFunc   : { enable: 0 },
            jumpChange   : 1,
            changeWording: '已存入零钱，可直接提现',   //查询接口返回'已存入零钱，可直接转账'
            sendUserName : 'wxid_xxx'       //发送者wxid
          },
        message: '',
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async queryRedPacket(rawMsgData, index = 0) {
    return await this.sendCmd('queryRedPacket', {
      rawMsgData,
      index,
    })
  }

  /**
  * 领取红包
  *
  * @param {object} rawMsgData - 推送的消息结构体，即`push`事件中收到的Object
  * @param {string} key - 红包的验证key，通过调用 receiveRedPacket 获得
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * 已领取过红包：
  * ```
  {
    success: true,
    data   :
      {
        external: {
          retcode: 268502336,
          retmsg : '你已领取过该红包'
        },
        message: '',
        status : 0
      }
  }
  * ```
  *
  * 未领取过的红包：
  * ```
  {
    success: true,
    data   :
      {
        external:
          {
            retcode        : 0,
            retmsg         : 'ok',
            sendId         : '1000039501201804087013251181768',
            amount         : 1,
            recNum         : 2,
            recAmount      : 2,
            totalNum       : 3,
            totalAmount    : 4,
            hasWriteAnswer : 0,
            hbType         : 1,
            isSender       : 0,
            isContinue     : 0,
            receiveStatus  : 2,
            hbStatus       : 3,
            statusMess     : '',
            wishing        : '发3个红包',
            receiveId      : '1000039501001804087013251181768',
            headTitle      : '领取2/3个',
            canShare       : 0,
            operationHeader: [],
            record         :
              [
                {
                  receiveAmount: 1,
                  receiveTime  : '1523171198',
                  answer       : '',
                  receiveId    : '1000039501001804087013251181768',
                  state        : 1,
                  receiveOpenId: '1000039501001804087013251181768',
                  userName     : 'wxid_xxx'
                },
                {
                  receiveAmount: 1,
                  receiveTime  : '1523170992',
                  answer       : '',
                  receiveId    : '1000039501000804087013251181768',
                  state        : 1,
                  receiveOpenId: '1000039501000804087013251181768',
                  userName     : 'binsee'
                }
              ],
            watermark       : '',
            jumpChange      : 1,
            changeWording   : '已存入零钱，可直接提现',
            sendUserName    : 'binsee',
            SystemMsgContext:                 //系统消息内容
            '<img src="SystemMessages_HongbaoIcon.png"/>  你领取了$binsee$的<_wc_custom_link_ color="#FD9931" href="weixin://weixinhongbao/opendetail?sendid=1000039501201804087013251181768&sign=68b9858edbc9ff8a88fb8c8fa987edaad88078b31daf6e7af4dba06e78849e50b29a3c1d10bad4893aff116a0db80c7d8a3aa96a5247e1ed095d88e66983fc6fd9f6f6dc8243411ef97727cf0bc698c3&ver=6">红包</_wc_custom_link_>',
            sessionUserName: '4674258153@chatroom',   //会话wxid/chatroom
            realNameInfo   : { guideFlag: 0 }
          },
        message: '',
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async openRedPacket(rawMsgData, key) {
    return await this.sendCmd('openRedPacket', {
      rawMsgData,
      key,
    })
  }

  /** 公众号系列接口 */

  /**
  * 搜索公众号
  *
  * @param {string} content - 公众号名称等关键字
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        code: 0,
        info:
          {
            continueFlag: 1,   //仍有数据标志
            cookies     :      //cookie数据
              {
                businessType: 1,
                isHomepage  : 1,
                query       : '"腾讯"',
                scene       : 2
              },
            data:   //返回的搜索相关数据
              [{
                count: 20,
                items:      //搜索结果列表
                  [{
                    aliasName: 'tencent',
                    brandFlag: 2,
                    brandInfo:
                      {
                        urls:
                          [{
                            title: '查看历史消息',
                            url  :
                              'http://mp.weixin.qq.com/mp/getmasssendmsg?__biz=MzA3NDEyMDgzMw==#wechat_webview_type=1&wechat_redirect',
                            titleKey: '__mp_wording__brandinfo_history_massmsg'
                          }]
                      },
                    docID: '3074120833',
                    externalInfo:
                      {
                        Appid: 'wx06441a33a2a67de4',
                        BindWxaInfo:
                          {
                            wxaEntryInfo:
                              [{
                                title   : '腾讯+',
                                username: 'gh_3a5568e1268b@app',
                                iconUrl : 'http://mmbiz.qpic.cn/mmbiz_png/xxx/0?wx_fmt=png'
                              }]
                          },
                        FunctionFlag           : 1,
                        InteractiveMode        : '2',
                        IsAgreeProtocol        : '1',
                        IsHideInputToolbarInMsg: '0',
                        IsShowHeadImgInMsg     : '1',
                        RegisterSource         :
                          {
                            IntroUrl:
                              'http://mp.weixin.qq.com/mp/getverifyinfo?__biz=MzA3NDEyMDgzMw==&type=reg_info#wechat_redirect',
                            RegisterBody: '深圳市腾讯计算机系统有限公司'
                          },
                        RoleId        : '1',
                        ScanQRCodeType: 1,
                        ServiceType   : 0,
                        VerifySource  :
                          {
                            Description: '深圳市腾讯计算机系统有限公司',
                            IntroUrl   :
                              'http://mp.weixin.qq.com/mp/getverifyinfo?__biz=MzA3NDEyMDgzMw==#wechat_webview_type=1&wechat_redirect',
                            Type         : 0,
                            VerifyBizType: 1
                          }
                      },
                    friendsFollowCount: 0,
                    headHDImgUrl      : 'http://wx.qlogo.cn/mmhead/xxx/0',
                    headImgUrl        : 'http://wx.qlogo.cn/mmhead/xxx/132',
                    iconUrl           : 'http://mmbiz.qpic.cn/mmbiz_png/xxx/0?wx_fmt=png',
                    nickName          : '腾讯',
                    nickNameHighlight : '<em class="highlight">腾讯</em>',
                    segQuery          : ' 腾讯',
                    signature         : '腾讯公司唯一官方帐号。',
                    signatureHighlight: '<em class="highlight">腾讯</em>公司唯一官方帐号。',
                    userName          : 'gh_88b080670a71',
                    verifyFlag        : 24
                  }],
                keywordList: ['腾讯'],
                resultType : 0,
                title      : '公众号',
                totalCount : 1900,
                type       : 1
              }],
            direction : 2,
            exposeMs  : 500,
            isDivide  : 0,
            isExpose  : 1,
            isHomePage: 1,
            lang      : 'zh_CN',
            monitorMs : 100,
            offset    : 20,
            query     : '"腾讯"',
            resultType: 0,
            ret       : 0,
            searchID  : '18232918846508425807'
          },
        message: '',
        offset : 20,
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async searchMp(content) {
    return await this.sendCmd('searchMp', {
      content,
    })
  }

  /**
  * 获取公众号信息
  *
  * @param {string} ghName - 公众号gh名称，即`gh_`格式的id
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        info:
          {
            alias        : 'tencent',
            appid        : 'wx06441a33a2a67de4',
            bigHeadImgUrl: 'http://wx.qlogo.cn/mmhead/xxx/0',
            bindKFUin    : '0',
            bindWxaInfo  :
              {
                wxaEntryInfo:
                  [{
                    username: 'gh_3a5568e1268b@app',
                    title   : '腾讯+',
                    iconUrl : 'http://mmbiz.qpic.cn/mmbiz_png/xxx/0?wx_fmt=png'
                  }],
                bizEntryInfo: []
              },
            bitMask     : '4294967295',
            brandIconURL: 'http://mmbiz.qpic.cn/mmbiz_png/xxx/0?wx_fmt=png',
            brandInfo   :
              {
                urls:
                  [{
                    title   : '查看历史消息',
                    url     : 'http://mp.weixin.qq.com/mp/getmasssendmsg?xxxx',
                    titleKey: '__mp_wording__brandinfo_history_massmsg'
                  }]
              },
            functionFlag           : '1',
            interactiveMode        : '2',
            isAgreeProtocol        : '1',
            isHideInputToolbarInMsg: '0',
            isShowHeadImgInMsg     : '1',
            mmBizMenu              :
              {
                uin            : 3074120833,
                version        : 425306837,
                interactiveMode: 2,
                updateTime     : 1518401098,
                buttonList     :
                  [
                    {
                      id   : 425306837,
                      type : 0,
                      name : '产品体验',
                      key  : 'rselfmenu_2',
                      value: '',
                      subButtonList:
                        [{
                          id           : 425306837,
                          type         : 2,
                          name         : '往期内测',
                          key          : 'rselfmenu_2_1',
                          value        : 'http://mp.weixin.qq.com/mp/xxxxx',
                          subButtonList: [],
                          nativeUrl    : ''
                        }],
                      nativeUrl: ''
                    }]
              },
            nickName : '腾讯',
            pyInitial: 'TX',
            quanPin  : 'tengxun',
            registerSource:
              {
                registerBody: '深圳市腾讯计算机系统有限公司',
                introUrl    : 'http://mp.weixin.qq.com/mp/getverifyinfo?xxxx'
              },
            roleId         : '1',
            scanQRCodeType : '1',
            serviceType    : '0',
            signature      : '腾讯公司唯一官方帐号。',
            smallHeadImgUrl: 'http://wx.qlogo.cn/mmhead/xxx/132',
            userName       : 'gh_88b080670a71',
            verifyFlag     : '24',
            verifyInfo     : '深圳市腾讯计算机系统有限公司',
            verifySource   :
              {
                description  : '深圳市腾讯计算机系统有限公司',
                introUrl     : 'http://mp.weixin.qq.com/mp/getverifyinfo?xxx',
                type         : 0,
                verifyBizType: 1
              }
          },
        message: ' ',
        status : 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async getSubscriptionInfo(ghName) {
    return await this.sendCmd('getSubscriptionInfo', {
      ghName,
    })
  }

  /**
  * 操作公众号菜单
  *
  * @param {string} ghName - 公众号gh名称，即`gh_`格式的id
  * @param {Number} menuId - 菜单id
  * @param {string} menuKey - 菜单key
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   : {
      message: '',
      status : 0
    }
  }
  * ```
  * @memberof Padchat
  */
  async operateSubscription(ghName, menuId, menuKey) {
    return await this.sendCmd('operateSubscription', {
      ghName,
      menuId,
      menuKey,
    })
  }

  /**
  * 获取网页访问授权
  *
  * @param {string} ghName - 公众号gh名称，即`gh_`格式的id
  * @param {string} url - 网页url
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        info:
          {
            'X-WECHAT-KEY': 'xxxxxxxxxxxx',   //授权key
            'X-WECHAT-UIN': 'MTQ5ODA2NDYw'    //授权uin
          },
        message: '',
        status : 0,
        fullUrl:      //完整授权访问url
        'https://mp.weixin.qq.com/s?__biz=MzA5MDAwOTExMw==&mid=200126214&idx=1&sn=a1e7410ec56de5b6c4810dd7f7db8a47&chksm=1e0b3470297cbd666198666278421aed0a131d775561c08f52db0c82ce0e6a9546aac072a20e&mpshare=1&scene=1&srcid=0408bN3ACxqAH6jyq4vCBP9e&ascene=7&devicetype=iPad+iPhone+OS9.0.2&version=16060125&nettype=WIFI&lang=zh_CN&fontScale=100&pass_ticket=ZQW8EHr9vk%2BPGoWzmON4ev8I0MmliT4mp1ERTPEl8lc%3D&wx_header=1',
        shareUrl:   //分享url
        'http://mp.weixin.qq.com/s/QiB3FPE6fJmV6asvvxIkvA'
      }
  }
  * ```
  * @memberof Padchat
  */
  async getRequestToken(ghName, url) {
    return await this.sendCmd('getRequestToken', {
      ghName,
      url,
    })
  }

  /**
  * 访问网页
  *
  * @param {string} url - 网页url地址
  * @param {string} xKey - 访问Key，用`getRequestToken`获取
  * @param {string} xUin - 访问uin，用`getRequestToken`获取
  * @returns {Promise<object>} 返回Promise<object>，注意捕捉catch
  * ```
  {
    success: true,
    data   :
      {
        message : '',
        response:      //完整的访问结果原始数据文本（包含http头数据）
          'HTTP/1.1 200 OK\r\nContent-Security-Policy: script-src \'self\' \'unsafe-inline\' \'unsafe-eval\' http://*.qq.com https://*.qq.com http://*.weishi.com https://*.weishi.com xxxxxxxxxxxxxxxxxxxxxxxxxxx',
        status: 0
      }
  }
  * ```
  * @memberof Padchat
  */
  async requestUrl(url, xKey, xUin) {
    return await this.sendCmd('requestUrl', {
      url,
      xKey,
      xUin,
    })
  }
}
/**
 * 等待指定cmdId返回
 *
 * @param {string} cmdId - 要监听的cmdId
 * @param {number} [timeout=3000] 超时时间默认为3秒
 * @private
 * @returns {Promise<object>}
 */
async function getCmdRecv(cmdId, timeout = 3000) {
  if (!cmdId) {
    throw new Error('未指定cmdID！')
  }
  cmdId = 'RET#' + cmdId
  // console.log('进入 getCmdRecv，应该监听: %s', cmdId)

  return new Promise((res, rej) => {
    // 如果某操作超过指定时间没有返回结果，则认为是操作超时
    const timeOutHandle = setTimeout(() => {
      this.removeAllListeners(cmdId)
      rej(new Error('等待指令操作结果超时！当前超时时间为:' + timeout * 1000))
    }, timeout * 1000)

    this.once(cmdId, data => {
      // console.log('监听到 %s 事件', cmdId, data)
      clearTimeout(timeOutHandle)
      res(data)
    })
  })
}

/**
 * 加工处理ws接收到的数据
 *
 * @param {string} msg - ws连接接收到的文本消息
 * @private
 */
function onWsMsg(msg) {
  let data
  // console.log('进入 onWsMsg', msg)
  try {
    if (typeof msg === 'string') {
      data = JSON.parse(msg)
    } else {
      throw new Error('ws传输的数据不是字符串格式！')
    }
  } catch (e) {
    this.emit('error', new Error('解析msg数据失败: ' + e.message))
    return
  }

  if (data.data) {
    if (data.data.data) {
      // 解析扩展数据的json文本

      if (data.data.data.external) {
        try {
          //解析红包及转账接口返回数据
          data.data.data.external = JSON.parse(data.data.data.external)
        } catch (e) { }
      }

      if (data.data.data.info) {
        try {
          //解析公众号接口返回数据
          data.data.data.info = JSON.parse(data.data.data.info)

          const info   = data.data.data.info
          const fields = [
            'BrandInfo',
            'externalInfo',
            'MMBizMenu',
            'RegisterSource',
            'VerifySource',
            'Location',
            'cookies',
            'brandInfo',
            'BindWxaInfo',
          ]

          // 解析`getSubscriptionInfo`接口返回数据字段
          fields.forEach(field => {
            if (!info[field]) { return }
            try {
              info[field] = JSON.parse(info[field])
            } catch (e) { }
          })

          //解析`searchMp`接口返回数据字段
          info.data.forEach((d_item, d_index) => {
            //第一层数组
            if (!d_item.items) { return }
            const _item = info.data[d_index]

            _item.items.forEach((item, index) => {
              //第二层数组，即真实的搜索结果列表
              const _item2 = _item.items[index]
              fields.forEach(field => {
                if (!_item2[field]) { return }
                try {
                  _item2[field] = JSON.parse(_item2[field])
                } catch (e) { }
              })
            })
          })
        } catch (e) { }
      }

      if (data.data.data.member) {
        try {
          //解析获取群成员接口返回数据
          data.data.data.member = JSON.parse(data.data.data.member)
        } catch (e) { }
      }
    }
    // 转小驼峰
    data.data = Helper.toCamelCase(data.data)
  }

  this.emit('msg', data)
  // TODO: 补充push数据格式

  /**
   * 返回数据结果:
   data = {
     type  : 'cmdRet',                                 //返回数据包类型
     cmdId : 'b61eb250-3770-11e8-b00f-595f9d4f3df0',   //请求id
     taskId: '5',                                      //服务端返回当前实例的任务ID
     data  :                                           //荷载数据（以下字段名称为转换为小驼峰后的，原始数据为下划线分隔）
     {
       error  : '',     //错误提示
       msg    : '',     //其他提示信息
       success: true,   //接口执行是否成功
       data   :         //接口执行结果数据，`push`类型无
       {
         message: '',
         msgId  : '1284778244346778513',
         status : 0
       },
       list:   // 仅`push`类型拥有，包含多个push结构数据
         [
           {
             content    : '信息内容',                  //消息内容或xml结构体内容
             continue   : 1,
             description: '杉木 : 信息内容',             //描述内容
             fromUser   : 'wxid_001',              //发信人
             msgId      : '4032724472820776289',   //消息id
             msgSource  : '',
             msgType    : 5,                       //消息主类型，类型为5时则用子类型判断
             status     : 1,
             subType    : 1,                       //消息子类型
             timestamp  : 1522921008,              //消息时间戳
             toUser     : 'wxid_002',              //收件人
             uin        : 149801234,               //用户uin，全局唯一
             mType      : 1                        //消息类型。等同msgType，当msgType为5时，等同于subType
           }
         ],
     },
   }
   */

  let hasOn
  switch (data.type) {
    case 'cmdRet':
      if (data.type === 'cmdRet' && data.cmdId) {
        hasOn = this.emit('RET#' + data.cmdId, data)
        if (!hasOn) {
          this.emit('warn', new Error(`返回执行结果没有被监听！指令ID:${data.cmdId}`))
        }
      }
      break;

    case 'userEvent':
      switch (data.event) {
        case 'warn':
          // 如果success字段为true，则为不严重的问题
          this.emit('warn', new Error('服务器返回错误提示：' + data.data.error), data.success)
          break
        case 'qrcode':   // 微信扫码登陆，推送二维码
        case 'scan'  :   // 微信账号扫码事件
        case 'login' :   // 微信账号登陆成功
        case 'loaded':   // 通讯录载入完毕
        case 'logout':   // 微信账号退出
        case 'over'  :   // 实例注销（账号不退出）
        case 'sns'   :   // 朋友圈事件：新评论
          this.emit(data.event, data.data || {}, data.data.msg)
          break
        case 'push':
          if (!data.data || !Array.isArray(data.data.list) || data.data.list.length <= 0) {
            this.emit('error', new Error('推送数据异常！'))
            break
          }
          data.data.list.forEach(item => {
            const type = item.msgType
            // 过滤无意义的2048和32768类型数据
            if (type === undefined || type === 2048 || type === 32768) {
              return null
            }
            // 当msg_type为5时，即表示推送的信息类型要用sub_type进行判断
            // 另外增加一个属性来存储好了
            item.mType = item.msgType === 5 ? item.subType : item.msgType
            // 解析群成员列表
            if (item.member) {
              try {
                item.member = JSON.parse(item.member) || []
              } catch (e) {
              }
            }
            this.emit('push', item)
          })
          break
        default:
          this.emit('other', data)
          break
      }
      break
    default:
      this.emit('other', data)
      break;
  }
}

/**
 * 清除消息结构中多余字段
 *
 * @param {object} obj - 要处理的数据结构
 * @private
 * @returns {object}
 */
function clearRawMsg(obj) {
  if (typeof obj === 'object') {
    delete obj.data
  }
  return obj
}


Padchat.loginType = loginType
Padchat.blacklist = blacklist
module.exports    = Padchat
