require('babel-regenerator-runtime')
var async = require('watt')
try {
  var dns = require('dns')
  var net = require('net')
} catch (err) {}

module.exports = {
  dns: function (uri, opts) {
    if (typeof dns === 'undefined') {
      throw new Error('DNS seeds are only available in Node')
    }
    if (!opts || !opts.defaultPort) {
      throw new Error('Must provide default port option')
    }
    return async(function * (next) {
      var addresses = yield dns.resolve(uri, next)
      var address = addresses[Math.floor(Math.random() * addresses.length)]
      var socket = net.connect(opts.defaultPort, address, uri)
      socket.once('error', next.error.bind(next))
      yield socket.once('connect', next)
      return socket
    })
  },

  web: function (uri, opts) {
    if (!process.browser && !opts.wrtc) {
      throw new Error('Must provide wrtc option')
    }
    return function () {
      throw new Error('Not yet implemented')
    }
  }
}
