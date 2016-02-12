try {
  var dns = require('dns')
  var net = require('net')
} catch (err) {}

function dnsSeed (uri, opts) {
  if (typeof dns === 'undefined') {
    throw new Error('DNS seeds are only available in Node')
  }
  if (!opts || !opts.defaultPort) {
    throw new Error('Must provide default port option')
  }
  return function (cb) {
    dns.resolve(uri, function (err, addresses) {
      if (err) return cb(err)
      var address = addresses[Math.floor(Math.random() * addresses.length)]
      var socket = net.connect(opts.defaultPort, address, uri)
      socket.once('error', cb)
      socket.once('connect', function () {
        cb(null, socket)
      })
    })
  }
}

function webSeed (uri, opts) {
  if (!process.browser && !opts.wrtc) {
    throw new Error('Must provide wrtc option')
  }
  return function () {
    throw new Error('Not yet implemented')
  }
}

function fixedSeed (uri, opts) {
  return function (cb) {
    if (!net) throw new Error('Could not create TCP connection')
    var socket = net.connect(opts.defaultPort, uri, (err) => {
      if (err) return cb(err)
      cb(null, socket)
    })
  }
}

module.exports = {
  dns: dnsSeed,
  web: webSeed,
  fixed: fixedSeed
}
