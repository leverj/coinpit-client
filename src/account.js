module.exports = function (serverResponse, loginless, socket, insightutil) {
  var bluebird    = require('bluebird')
  var nodeUUID    = require('node-uuid')
  var assert      = require('affirm.js')
  var _           = require('lodash')
  var mangler     = require('mangler')
  var util        = require('util')
  var accountUtil = require('./accountUtil')
  var bitcoinutil = require("bitcoinutil")(serverResponse.config.network)
  var txutil      = require('./txutil')
  var account     = {}
  var positions, pnl, availableMargin, readonlyApp, ioconnected
  var bidAsk      = {}
  var validator   = require("./validator")(serverResponse.instrument)
  var promises    = {}

  account.config     = serverResponse.config
  account.openOrders = {}
  account.logging    = false

  var multisigBalance, marginBalance

  account.getOpenOrders = function () {
    return Object.keys(account.openOrders).map(function (uuid) {
      return _.cloneDeep(account.openOrders[uuid])
    })
  }

  account.getBidAsk = function () {
    return bidAsk
  }

  account.getBalance = function () {
    return {
      balance        : multisigBalance.balance + marginBalance.balance + (pnl ? pnl.pnl : 0),
      availableMargin: availableMargin,
      multisig       : _.cloneDeep(multisigBalance),
      margin         : _.cloneDeep(marginBalance)
    }
  }

  account.createOrders = function (orders) {
    return promised(orders, "POST", "/order", function () {
      logOrders(orders)
      validator.validateCreateOrder(orders)
      account.assertAvailableMargin(orders)
    })
  }

  account.updateOrders = function (orders) {
    return promised({ orders: orders }, "PUT", "/order", function () {
      logOrders(orders)
      validator.validateUpdateOrder(orders, account.openOrders)
      account.assertAvailableMargin(orders)
    })
  }

  account.cancelOrder = function (order) {
    return promised([order.uuid], "DELETE", "/order")
  }

  account.closeAll = function () {
    return promised([], "DELETE", "/order")
  }

  account.transferToMargin = function (amountInSatoshi, feeInclusive) {
    return insightutil.getConfirmedUnspents(multisigBalance.address).then(function (confirmedUnspents) {
      var tx     = txutil.createTx(
        {
          input       : multisigBalance.address,
          destination : marginBalance.address,
          amount      : amountInSatoshi,
          unspents    : confirmedUnspents,
          isMultisig  : true,
          network     : account.config.network,
          feeInclusive: feeInclusive
        })
      var signed = bitcoinutil.sign(tx, account.userPrivateKey, account.redeem, true)
      return loginless.rest.post('/api/margin', { requestid: nodeUUID.v4() }, [{ txs: [signed] }])
    })
  }

  account.withdraw = function (address, amountSatoshi, feeSatoshi) {
    return insightutil.getConfirmedUnspents(account.accountid).then(function (unspents) {
      var amount   = Math.floor(amountSatoshi)
      var fee      = Math.floor(feeSatoshi)
      var tx       = txutil.createTx({ input: account.accountid, isMultisig: true, amount: amount, destination: address, unspents: unspents, txFee: fee })
      var signedTx = bitcoinutil.sign(tx, account.userPrivateKey, account.redeem, true)
      return loginless.rest.post('/api/tx', {}, { tx: signedTx })
    })
  }

  account.recoveryTx = function () {
    return loginless.rest.get('/api/withdrawtx').then(function (withdraw) {
      return bitcoinutil.sign(withdraw.tx, account.userPrivateKey, account.redeem)
    }).catch(handleError)
  }

  account.clearMargin = function () {
    return loginless.rest.del("/api/margin").catch(handleError)
  }

  account.updateAccountBalance = function () {
    return bluebird.all([insightutil.getAddress(account.serverAddress), insightutil.getAddress(account.accountid)])
      .then(function (balances) {
        addressListener(balances[0])
        addressListener(balances[1])
      })
  }

  account.getUserDetails = function () {
    return loginless.rest.get("/api/userdetails").then(refreshWithUserDetails).catch(handleError)
  }

  account.fixedPrice = function (price) {
    assert(price, 'Invalid Price:' + price)
    return price.toFixed(account.config.instrument.ticksize) - 0
  }

  account.newUUID = function () {
    return nodeUUID.v4()
  }

  function onReadOnly(status) {
    if (readonlyApp == status.readonly) return
    if (status.readonly) return readonlyApp = status.readonly
    loginless.socket.register(socket)
    account.getUserDetails().then(function () {
      readonlyApp = status.readonly
    })
  }

  function onConnect(message) {
    if (!ioconnected) {
      ioconnected = true
      loginless.socket.register(socket)
      account.getUserDetails()
    }
  }

  function onDisconnect() {
    ioconnected = false
  }

  function onAuthError(message) {
    loginless.socket.onAuthError(socket, message)
  }

  function onOrderAdd(response) {
    updateOrders(response.result)
    respondSuccess(response.requestid, _.cloneDeep(response.result))
  }

  function onOrderUpdate(response) {
    onOrderAdd(response)
  }

  function onOrderDel(response) {
    delete account.openOrders[response.result]
    respondSuccess(response.requestid, response.result)
    availableMargin = account.calculateAvailableMargin(account.getOpenOrders())
  }

  function onFlat(response) {
    account.getUserDetails().then(function () {
      respondSuccess(response.requestid, _.cloneDeep(account.openOrders))
    })
  }

  function onError(response) {
    respondError(response.requestid, response.error)
    refreshWithUserDetails(response.userDetails)
    if (!response.requestid) {
      //todo: this needs to be handled
      handleError("Error without requestid", response.error)
    }
  }

  function myMessageReceived(message) {
    if (account.logging) util.log(Date.now(), "user details refreshed ")
    if (message.error) {
      handleError(message.error)
    }
    refreshWithUserDetails(message.userDetails)
  }

  function onTrade(trade) {
    // util.log('Date.now(), trades', trade)

  }

  function promised(body, method, uri, fn) {
    var requestid = nodeUUID.v4()
    return new bluebird(function (resolve, reject) {
      if (fn) {
        try {
          fn()
        } catch (e) {
          reject(e)
          return
        }
      }
      try {
        promises[requestid] = { resolve: resolve, reject: reject, time: Date.now() }
        loginless.socket.send(socket, method, uri, { requestid: requestid }, body)
      } catch (e) {
        onError({ requestid: requestid, error: e })
      }
    })
  }

  function updateOrders(orders) {
    for (var i = 0; i < orders.length; i++) {
      account.openOrders[orders[i].uuid] = orders[i]
    }
    availableMargin = account.calculateAvailableMargin(account.getOpenOrders())
  }

  function onOrderBook(data) {
    bidAsk = {
      bid: data.bid,
      ask: data.ask
    }
  }

  function onDiffOrderBook(diffOrderBook) {
    onOrderBook(diffOrderBook)
  }

  function onConfig(config) {
    account.config = config
  }

  function respondSuccess(requestid, response) {
    respond(requestid, response, 'resolve')
  }

  function respondError(requestid, response) {
    respond(requestid, response, 'reject')
  }

  function respond(requestid, response, method) {
    if (!requestid || !promises[requestid]) return
    promises[requestid][method](response)
    delete promises[requestid]
  }

  function handleError() {
    if (account.logging) util.log(Date.now(), arguments)
  }

  function refreshWithUserDetails(userDetails) {
    if (!userDetails) return
    account.openOrders = mangler.mapify(userDetails.orders, 'uuid')
    positions          = userDetails.positions
    pnl                = userDetails.pnl
    availableMargin    = userDetails.margin
  }

  account.assertAvailableMargin = function (orders) {
    var margin = account.getPostAvailableMargin(orders)
    assert(margin >= 0, "Insufficient margin ", margin, ".add margin")
  }

  account.getPostAvailableMargin = function (orders) {
    var ordersMap = getOpenOrdersIfSuccess(orders)
    return account.calculateAvailableMargin(_.toArray(ordersMap))
  }

  function getOpenOrdersIfSuccess(orders) {
    var ordersMap = _.cloneDeep(account.openOrders)
    for (var i = 0; i < orders.length; i++) {
      var order       = orders[i];
      var uuid        = order.uuid || nodeUUID.v4()
      ordersMap[uuid] = order
    }
    return ordersMap
  }

  account.calculateAvailableMargin = function (orders) {
    return accountUtil.computeAvailableMarginCoverage(orders, pnl, account.config.instrument, marginBalance.balance)
  }

  function logOrders(orders) {
    if (!account.logging) return
    orders.forEach(function (order) {
      util.log(Date.now(), order.uuid ? "update" : "create", "uuid", order.uuid, "price", order.price, "side", order.side, "type", order.orderType)
    })
  }

  function copyFromLoginlessAccount() {
    Object.keys(loginless.getAccount()).forEach(function (key) {
      account[key] = loginless.getAccount()[key]
    })
  }

  function setupSocketEvents() {
    var eventMap = {
      // version         : onVersion,
      trade           : onTrade,
      orderbook       : onOrderBook,
      difforderbook   : onDiffOrderBook,
      config          : onConfig,
      readonly        : onReadOnly,
      // advisory        : onAdvisory,
      reconnect       : onConnect,
      connect_error   : onDisconnect,
      connect_timeout : onDisconnect,
      reconnect_error : onDisconnect,
      reconnect_failed: onDisconnect,
      order_add       : onOrderAdd,
      order_del       : onOrderDel,
      order_error     : onError,
      orders_del      : onFlat,
      order_update    : onOrderUpdate,
      user_message    : myMessageReceived,
      ntp             : loginless.socket.ntp.bind(loginless.socket),
      auth_error      : onAuthError
    }

    Object.keys(eventMap).forEach(function (event) {
      socket.removeListener(event, eventMap[event])
      socket.on(event, eventMap[event])

    })
  }

  function addressListener(addressInfo) {
    switch (addressInfo.address) {
      case account.accountid:
        // if (myConfirmedBalance !== addressInfo.confirmed) adjustMarginSequentially()
        multisigBalance = addressInfo
        break;
      case account.serverAddress:
        marginBalance = addressInfo
        break
      default:
        insightutil.unsubscribe(addressInfo.address)
    }
  }

  function init() {
    setupSocketEvents()
    copyFromLoginlessAccount()
    insightutil.subscribe(account.accountid, addressListener)
    insightutil.subscribe(account.serverAddress, addressListener)
  }

  init()
  return account
}
