<template>
  <section class="is-full-height has-background-shade-3">
    <div class="is-flex is-justify-content-center is-full-height" style="overflow-y:auto;">
      <!-- Guest access not allowed message -->
      <div v-if="server === null" class="message is-danger is-light is-align-self-center">
        <div class="message-body has-text-danger">Anonymous access is not allowed<br>Please <router-link :to="{ name: 'login' }">login</router-link></div>
      </div>
      <!-- User nickname form -->
      <div v-else class="is-align-items-center is-align-self-center">
        <form @submit.prevent="join">
          <div class="field has-addons">
            <div class="control has-icons-left">
              <input v-model="nick" autofocus class="input" type="text" name="nick" placeholder="Nickname">
              <span class="icon is-small is-left">
                <i class="fa fa-user" />
              </span>
            </div>
            <div class="control">
              <button type="submit" class="button is-primary" :disabled="!hasValidNick">
                <span class="icon">
                  <i class="fa fa-sign-in" /></span>
                <span>Join</span>
              </button>
            </div>
          </div>
        </form>
        <div v-if="error" class="message is-danger is-light mt-4">
          <div class="message-body has-text-danger">{{ error }}</div>
        </div>
      </div>
    </div>
  </section>
</template>

<script>
export default {
  name: 'GuestHome',
  props: {
    requestedJid: {
      type: String,
      default: null,
    },
  },
  data () {
    return {
      nick: '',
      isLoading: false,
      error: '',
      transportsUser: {
        websocket: window.config.transports.websocket,
        bosh: window.config.transports.bosh,
      },
      server: window.config.anonymousHost,
    }
  },
  computed: {
    hasValidNick () { return this.nick.length > 2 },
  },
  mounted () {
    // remove navbar spacing
    document.body.classList.remove('has-navbar-fixed-top')
  },
  methods: {
    async join () {
      this.isLoading = true
      try {
        await this.$xmpp.create(null, null, this.server, this.transportsUser, this)
        this.$xmpp.setNick(this.nick)
        await this.$xmpp.connect()
        this.$router.push({ name: 'guestRooms', params: { nick: this.nick, requestedJid: this.requestedJid } })
      } catch (error) {
        this.error = error.message
      }
      this.isLoading = false
    },
  },
}
</script>
