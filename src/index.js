module.exports = function (coinpitUrl) {
  // var socket   = require("socket.io-client")(coinpitUrl, { rejectUnauthorized: true })
  var rest     = require('rest.js')
  var bluebird = require('bluebird')
  var util     = require('util')
  var client   = {}

  client.getAccount = function (privKey) {
    var config, loginless, instrumentConfig

    return rest.get(coinpitUrl + '/api/v1/config').then(function (response) {
      config    = response.body.config
      instrumentConfig = response.body.instruments
      loginless = createLoginless(config)
      return loginless.getServerKey(privKey).then(createAccount).then(updateUserDetails)
    })

    function updateUserDetails(account) {
      var promises = bluebird.all([account.getUserDetails(), account.updateAccountBalance()])
      return promises.then(function (response) {
        return account
      })
    }

    function createLoginless(config) {
      return require("loginless")(coinpitUrl, "/api/v1/auth/", config.network, util.log.bind(util))
    }

    function createAccount(serverResponse) {
      loginless.socket.register()
      var insightUtil = getInsightUtil()
      return require("./account")(serverResponse, loginless, insightUtil, config, instrumentConfig)
    }

    function getInsightUtil() {
      return require('insight-util')(config.blockchainapi.uri, config.blockchainapi.socketuri, config.network)
    }

  }

  return client
}