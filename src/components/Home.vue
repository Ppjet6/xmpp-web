<template>
  <div class="is-flex-tablet is-block-mobile is-full-height">
    <aside class="is-full-height-scrollable is-block-mobile is-flex-shrink-0 has-background-shade-3" :class="{ 'is-hidden-mobile': !displayContact }">
      <contacts />
    </aside>
    <router-view class="is-flex-grow-1" />
  </div>
</template>

<script>
import contacts from '../components/Contacts.vue'

export default {
  name: 'Home',
  components: {
    contacts,
  },
  props: {
    jid: {
      type: String,
      default: null,
    },
  },
  computed: {
    displayContact () {
      return this.$route.meta.displayContact
    },
    userJid () {
      return this.$xmpp.fullJid
    },
  },
  // watch network status for resuming session
  watch: {
    jid: function resetActiveChat () {
      if (this.jid === null) {
        this.$store.setActiveChat({
          activeChat: null,
        })
      }
    },
  },
  mounted () {
    // check if user is connected
    if (this.userJid === null) {
      // user not connected, return to login page
      localStorage.removeItem('auth')
      this.$router.replace({ name: 'login', query: { redirect: this.$route.fullPath } })
    }
    // disconnect before leaving page
    window.addEventListener('beforeunload', async () => {
      await this.$xmpp.disconnect()
    })
  },
}
</script>
