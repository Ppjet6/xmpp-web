/* eslint-disable no-console */
import * as XMPP from 'stanza'
import defaultAvatar from '@/assets/defaultAvatar'
import axios from 'axios'
const transports = window.config.transports
const resource = window.config.resource
const defaultDomain = window.config.defaultDomain
const hasHttpAutoDiscovery = window.config.hasHttpAutoDiscovery

export default {

  jid: null,
  fullJid: null,
  context: null,
  client: null,
  nick: null,
  isAnonymous: true,

  // create XMPP client with credentials and context
  create (jid, password, server, transportsUser, context) {
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve) => {
      // set default domain if missing
      if (!/\S+@\S+\S+/.test(jid)) {
        jid += '@' + defaultDomain
      }
      if (this.jid) {
        this.isAnonymous = false
      }
      this.jid = jid
      this.context = context

      // use transports if user provided them
      if (transportsUser.bosh) {
        transports.bosh = transportsUser.bosh
      }
      if (transportsUser.websocket) {
        transports.websocket = transportsUser.websocket
      }

      // if active, try to get well-known/host-meta from domain
      const userDomain = this.jid.split('@')[1]
      if (hasHttpAutoDiscovery && userDomain !== defaultDomain) {
        try {
          const response = await axios.get('https://' + userDomain + '/.well-known/host-meta.json', { maxRedirects: 1 })
          response.data.links.forEach(link => {
            if (link.rel === 'urn:xmpp:alt-connections:xbosh' && link.href) {
              transports.bosh = link.href
            }
            if (link.rel === 'urn:xmpp:alt-connections:websocket' && link.href) {
              transports.websocket = link.href
            }
          })
        } catch (error) {
          console.error('Auto-discovery failed:', error.message)
        }
      }

      // create Stanza client
      this.client = XMPP.createClient({
        jid,
        password,
        server,
        resource: resource || 'Web XMPP',
        transports: transports || { websocket: true, bosh: true },
      })

      // debug stanza on dev mode
      if (process.env.NODE_ENV !== 'production') {
        this.client.on('*', (name, data) => {
          switch (name) {
            case 'raw:incoming':
            // case 'raw:outgoing':
              return
          }
          console.debug(name, data)
        })
      }
      resolve()
    })
  },

  // connect client to XMPP server
  connect () {
    const timeoutDuration = 5000
    let timeoutId = null
    const timeoutPromise = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        clearTimeout(timeoutId)
        reject(new Error('Server unreachable'))
      }, timeoutDuration)
    })

    const connectPromise = new Promise((resolve, reject) => {
      // listen for websocket failure
      const _xmppSocket = this
      function retryWithoutWebsocket (error) {
        if (!error || error.type !== 'close') {
          return
        }
        console.error('socket not work, try bosh', transports)
        _xmppSocket.client.off('disconnected', retryWithoutWebsocket)
        transports.websocket = false
        _xmppSocket.connect()
          .then(() => {
            clearTimeout(timeoutId)
            resolve()
          })
          .catch((error) => {
            clearTimeout(timeoutId)
            reject(error)
          })
      }
      if (transports.websocket) {
        _xmppSocket.client.on('disconnected', retryWithoutWebsocket)
      }

      // listen for authentication failure
      this.client.on('auth:failed', () => {
        clearTimeout(timeoutId)
        reject(new Error('Check your credentials'))
      })

      // listen for authentication success
      this.client.on('auth:success', () => {
        // remove websocket failure listener
        this.client.off('disconnected', retryWithoutWebsocket)
        localStorage.setItem('jid', this.jid)
        localStorage.setItem('auth', true)
        // resolve when listen is resolved
        this.listen()
          .then(() => {
            clearTimeout(timeoutId)
            resolve()
          })
      })

      try {
        this.client.connect()
      } catch (error) {
        reject(new Error('Error during login'))
      }
    })

    return Promise.race([
      connectPromise,
      timeoutPromise,
    ])
  },

  // logic post connection (listeners)
  listen () {
    function storeMessage (xmppSocket, type, message) {
      // clean body message if it contains only a link
      if (message.links) {
        if (message.links.some((link) => link.url === message.body)) {
          message.body = ''
        }
      }
      xmppSocket.context.$store.commit('storeMessage', {
        type,
        message: {
          id: message.id,
          from: message.from ? XMPP.JID.parse(message.from) : xmppSocket.fullJid,
          to: XMPP.JID.parse(message.to),
          body: message.body,
          delay: (message.delay && message.delay.timestamp) ? message.delay.timestamp : new Date().toISOString(),
          links: message.links || null,
        },
      })
    }

    return new Promise((resolve) => {
      // handle reconnection
      this.client.on('stream:management:resumed', () => {
        this.context.$store.commit('setOnline', true)
      })

      // handle session start
      this.client.on('session:started', () => {
        // store full Jid from server
        this.fullJid = XMPP.JID.parse(this.client.jid)
        this.context.$store.commit('setOnline', true)
        resolve()

        this.client.on('disconnected', () => {
          this.context.$store.commit('setOnline', false)
        })

        // get contacts (rfc6121)
        this.client.getRoster()
          .then((rosterResult) => {
            this.context.$store.commit('setRoster', rosterResult.items)

            // send presence to contacts (rfc6121)
            this.client.sendPresence()
          })
          .catch((rosterError) => console.error('getRoster', rosterError))

        // enable carbons (XEP-0280: Message Carbons)
        this.client.enableCarbons()
          .catch((error) => console.error('carbon', error))

        // get bookmarked rooms (XEP-0048: Bookmarks)
        this.client.getBookmarks()
          .then((mucBookmarks) => {
            this.context.$store.commit('setBookmarkedRooms', mucBookmarks)
            // get rooms attributes
            mucBookmarks.forEach((muc) => {
              this.client.getDiscoInfo(muc.jid, '')
                .then((mucDiscoInfoResult) => {
                  const room = this.setRoomAttributes(muc.jid, muc.name, mucDiscoInfoResult)
                  this.context.$store.commit('setBookmarkedRoom', room)
                })
                .catch((error) => console.error('getBookmarks/getDiscoInfo', error))
            })
          })
          .catch((error) => console.error('getBookmarks', error))

        // get HTTP file upload capacity (XEP-0363)
        this.client.getUploadService()
          .then((UploadServiceResult) => {
            if (UploadServiceResult.maxSize) {
              this.context.$store.commit('setHttpFileUploadMaxSize', UploadServiceResult.maxSize)
            }
          })
          .catch((error) => {
            console.warn(error.message)
          })
      })

      // listen for contact messages
      this.client.on('chat', (receivedMessage) => {
        storeMessage(this, 'chat', receivedMessage)
      })

      // listen for room messages
      this.client.on('groupchat', (receivedMessage) => {
        storeMessage(this, 'groupchat', receivedMessage)
      })

      // listen for room joined
      this.client.on('muc:join', (receivedMUCPresence) => {
        // @TODO add participants and role handling
        const occupantJid = XMPP.JID.parse(receivedMUCPresence.from)
        // @TODO better handle nick
        if (occupantJid.resource === this.fullJid.local) {
          this.context.$store.commit('setJoinedRoom', { jid: occupantJid.bare })
        }
      })

      // listen for message sent by user (direct or carbon)
      this.client.on('message:sent', (message) => {
        if (!message.body) {
          // no body in message (probably a chat state)
          return
        }
        storeMessage(this, null, message)
      })

      // listen for contact chat state (writing, pause, ...)
      this.client.on('chat:state', message => {
        this.context.$bus.$emit('chatState', {
          jid: XMPP.JID.parse(message.from).bare,
          chatState: message.chatState,
        })
      })

      // listen for presence
      this.client.on('available', available => {
        const fullJid = XMPP.JID.parse(available.from)
        if (!available.show) {
          // set default value to 'chat'
          available.show = 'chat'
        }
        if (fullJid.bare === this.jid) {
          // user presence
          if (fullJid.full === this.fullJid.full) {
            // user presence on current resource, emit event
            this.context.$bus.$emit('myPresence', available.show)
          }
          return
        }
        // contact presence commit to store
        this.context.$store.commit('setContactPresence', { jid: fullJid.bare, presence: available.show })
      })
    })
  },

  disconnect () {
    if (this.context) {
      if (this.client) {
        this.client.disconnect()
      }
    }
  },

  sendUrl (to, url, isMuc) {
    this.client.sendMessage({
      from: this.fullJid.full,
      to,
      body: url,
      type: isMuc ? 'groupchat' : 'chat',
      links: [{ url }],
    })
  },

  sendMessage (to, body, isMuc) {
    this.client.sendMessage({
      from: this.fullJid.full,
      to,
      body,
      type: isMuc ? 'groupchat' : 'chat',
    })
  },

  setRoomAttributes (jid, name, mucDiscoInfoResult) {
    const room = {
      jid: jid,
      name: name,
      password: null,
      isPublic: null,
      isPersistent: null,
      isPasswordProtected: null,
      isMembersOnly: null,
      isAnonymous: null,
      isModerated: null,
    }
    // public or hidden
    if (mucDiscoInfoResult.features.includes('muc_public')) {
      room.isPublic = true
    }
    if (mucDiscoInfoResult.features.includes('muc_hidden')) {
      room.isPublic = false
    }
    // persistent or temporary (destroyed if the last occupant exits)
    if (mucDiscoInfoResult.features.includes('muc_persistent')) {
      room.isPersistent = true
    }
    if (mucDiscoInfoResult.features.includes('muc_temporary')) {
      room.isPersistent = false
    }
    // password protected or not
    if (mucDiscoInfoResult.features.includes('muc_passwordprotected')) {
      room.isPasswordProtected = true
    }
    if (mucDiscoInfoResult.features.includes('muc_unsecured')) {
      room.isPasswordProtected = false
    }
    // members only or open
    if (mucDiscoInfoResult.features.includes('muc_membersonly')) {
      room.isMembersOnly = true
    }
    if (mucDiscoInfoResult.features.includes('muc_open')) {
      room.isMembersOnly = false
    }
    // semi-anonymous (display nick) or non-anonymous (display jid)
    if (mucDiscoInfoResult.features.includes('muc_semianonymous')) {
      room.isAnonymous = true
    }
    if (mucDiscoInfoResult.features.includes('muc_nonanonymous')) {
      room.isAnonymous = false
    }
    // moderated or not
    if (mucDiscoInfoResult.features.includes('muc_moderated')) {
      room.isModerated = true
    }
    if (mucDiscoInfoResult.features.includes('muc_unmoderated')) {
      room.isModerated = false
    }
    return room
  },

  getJidAvatar (jid) {
    return new Promise((resolve) => {
      const uri = localStorage.getItem('avatar-' + jid)
      if (uri) {
        return resolve(uri)
      }
      if (!this.client) {
        return resolve(defaultAvatar)
      }
      this.client.getVCard(jid)
        .then((data) => {
          if (!data.records) {
            return resolve(defaultAvatar)
          }
          const avatar = data.records.find((record) => record.type === 'photo')
          if (avatar && avatar.mediaType && avatar.data) {
            const uri = 'data:' + avatar.mediaType + ';base64,' + avatar.data
            localStorage.setItem('avatar-' + jid, uri)
            return resolve(uri)
          }
          return resolve(defaultAvatar)
        })
        .catch(() => {
          return resolve(defaultAvatar)
        })
    })
  },

  sendPresence (presence) {
    this.client.sendPresence(presence)
  },

  searchHistory (jid, last = true) {
    return new Promise((resolve, reject) => {
      const options = {
        with: jid,
        paging: {
          before: last,
          max: 50,
        },
      }
      this.client.searchHistory(options)
        .then((data) => {
        // get messages
          const messages = []
          data.results.forEach((item) => {
            if (!item.item.message || (!item.item.message.body && !item.item.message.links)) {
            // message de not have text (stanza maybe)
              return
            }
            if (this.context.$store.state.messages.some((message) => message.id === item.item.message.id)) {
            // message already known
              return
            }
            const message = {
              id: item.item.message.id,
              delay: item.item.delay.timestamp,
              from: XMPP.JID.parse(item.item.message.from),
              to: XMPP.JID.parse(item.item.message.to),
              body: item.item.message.body || null,
              links: item.item.message.links || null,
            }
            // clean body message if it contains only a link
            if (message.links) {
              if (message.links.some((link) => link.url === message.body)) {
                message.body = ''
              }
            }
            messages.push(message)
          })
          this.context.$store.commit('storePreviousMessages', messages)
          return resolve(data.paging)
        })
        .catch((error) => reject(error))
    })
  },

  async joinRoom (jid, nick = null, opts = {}) {
    if (nick === null) {
      if (this.nick !== null) {
        nick = this.nick
      } else {
        nick = this.fullJid.local
      }
    }
    try {
      await this.client.joinRoom(jid, nick, opts)
      return true
    } catch (error) {
      console.error('joinRoom', error)
      return false
    }
  },

  getPublicMuc () {
    return new Promise((resolve, reject) => {
      this.context.$store.commit('clearPublicRooms')
      // discoItems on server
      this.client.getDiscoItems(this.fullJid.domain, '')
        .then((serverDiscoItemsResult) => {
          if (serverDiscoItemsResult.items.length === 0) {
            return reject(new Error('There is no MUC service'))
          }
          // discoInfo on every service
          serverDiscoItemsResult.items.forEach((serverDiscoItem) => {
            this.client.getDiscoInfo(serverDiscoItem.jid, '')
              .then((serviceDiscoInfoResult) => {
                // @TODO use promise race
                if (serviceDiscoInfoResult.features.includes(XMPP.Namespaces.NS_MUC)) {
                  this.client.getDiscoItems(serverDiscoItem.jid, '')
                    .then((MucDiscoItemsResult) => {
                      // discoInfo on every MUC
                      MucDiscoItemsResult.items.forEach((MucDiscoItem) => {
                        this.client.getDiscoInfo(MucDiscoItem.jid, '')
                          .then((mucDiscoInfoResult) => {
                            if (mucDiscoInfoResult.features.includes(XMPP.Namespaces.NS_MUC)) {
                              // add room
                              const room = this.setRoomAttributes(MucDiscoItem.jid, MucDiscoItem.name, mucDiscoInfoResult)
                              this.context.$store.commit('setPublicRoom', room)
                            }
                          })
                      })
                      return resolve(MucDiscoItemsResult)
                    })
                  // catch discoItems on MUC error
                    .catch((error) => reject(error))
                }
              })
            // catch discoInfo error
              .catch((error) => reject(error))
          })
        })
      // catch discoItems on server error
        .catch((error) => reject(error))
    })
  },

  getDiscoItems (jid, node) {
    return new Promise((resolve, reject) => {
      this.client.getDiscoItems(jid, node)
        .then((data) => {
          return resolve(data)
        })
        .catch((error) => reject(error))
    })
  },

  getDiscoInfo (jid, node) {
    return new Promise((resolve, reject) => {
      this.client.getDiscoInfo(jid, node)
        .then((data) => {
          return resolve(data)
        })
        .catch((error) => reject(error))
    })
  },

  getUniqueRoomName (host) {
    return new Promise((resolve, reject) => {
      this.client.discoverBindings(host)
        .then((data) => {
          return resolve(data)
        })
        .catch((error) => reject(error))
    })
  },

  getServices (jid, string) {
    return new Promise((resolve, reject) => {
      this.client.getServices(jid, string)
        .then((data) => {
          return resolve(data)
        })
        .catch((error) => reject(error))
    })
  },

  // HTTP upload (XEP-0363)
  getUploadSlot (uploadService, uploadRequest) {
    return new Promise((resolve, reject) => {
      this.client.getUploadSlot(uploadService, uploadRequest)
        .then((data) => {
          return resolve(data)
        })
        .catch((error) => reject(error))
    })
  },

  // Set nickname
  setNick (nick) {
    this.nick = nick
  },

}
