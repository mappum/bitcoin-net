var test = require('tap').test
var params = require('webcoin-bitcoin').net
var u = require('bitcoin-util')
var Block = require('bitcoinjs-lib').Block
var PeerGroup = require('../lib/peerGroup.js')
var HeaderStream = require('../lib/headerStream.js')
// var BlockStream = require('../lib/blockStream.js')

test('PeerGroup constructor', (t) => {
  t.test('invalid params', (t) => {
    try {
      var peers = new PeerGroup({})
      t.fail('should have thrown')
      t.notOk(peers)
    } catch (err) {
      t.ok(err, 'error thrown')
      t.equal(err.message, 'Invalid network parameters', 'correct error message')
      t.end()
    }
  })

  t.test('valid params, no options', (t) => {
    var peers = new PeerGroup(params)
    t.ok(peers, 'created PeerGroup')
    t.end()
  })

  t.test('valid params, with options', (t) => {
    var peers = new PeerGroup(params, { numPeers: 4 })
    t.ok(peers, 'created PeerGroup')
    t.end()
  })

  t.end()
})

test('connect, disconnect', (t) => {
  // NOTE: this test connects to real nodes
  var numPeers = 8
  var peers = new PeerGroup(params, { numPeers })

  t.test('connect to peers', (t) => {
    var onPeer = (peer) => {
      t.ok(peer, 'got peer')
      t.ok(peer.ready, 'peer has completed handshake')
      t.equal(peer.magic, params.magic, 'correct magic bytes')
      t.ok(peer.socket.readable, 'peer transport socket is readable')
      t.ok(peer.socket.writable, 'peer transport socket is writable')
      if (peers.peers.length < numPeers) return
      t.pass('connected to `numPeers` peers')
      peers.removeListener('peer', onPeer)
      t.end()
    }
    peers.on('peer', onPeer)
    peers.connect()
    t.ok(peers.connecting, 'peers "connecting" state is true')
  })

  t.test('disconnect from peers', (t) => {
    var i = 0
    peers.on('disconnect', (peer) => {
      t.notOk(peers.connecting, 'peers "connecting" state is false')
      i++
      t.ok(peer, 'got disconnected peer')
      t.equal(peers.peers.length, numPeers - i, 'correct number of remaining peers')
      if (i < numPeers) return
      t.equal(peers.peers.length, 0, 'disconnected from all peers')
      t.end()
    })
    peers.disconnect()
  })

  t.end()
})

test('peer methods', (t) => {
  var numPeers = 4
  var pg = new PeerGroup(params, { numPeers })

  t.test('connect', (t) => {
    var onPeer = () => {
      if (pg.peers.length >= numPeers) {
        pg.removeListener('peer', onPeer)
        t.end()
      }
    }
    pg.on('peer', onPeer)
    pg.connect()
  })

  t.test('randomPeer', (t) => {
    var peers = pg.peers.slice(0)
    for (var i = 0; i < 100; i++) {
      var peer = pg.randomPeer()
      t.ok(peer, 'got peer')
      var index = peers.indexOf(peer)
      if (index !== -1) peers.splice(index, 1)
      if (peers.length === 0) break
    }
    t.equal(peers.length, 0, 'all peers returned from randomPeer()')
    t.end()
  })

  t.test('createHeaderStream', (t) => {
    var start = u.toHash('000000000000679c158c35a47eecb6352402baeedd22d0385b7c9d14a922f218')
    var stream = pg.createHeaderStream({ locator: [ start ] })
    t.ok(stream instanceof HeaderStream, 'got HeaderStream')
    var expectedHeaders = [
      {
        first: u.toHash('0000000000011d5533cc761e36eab351a92593dfd16c4c16b9076a4928c5c864'),
        last: u.toHash('00000000000051ffb3a39684c657ee29c8006489bfc3b33dc1a037352f79c784')
      },
      {
        first: u.toHash('000000000000b69e1df6199421f2b3cd942f29cd55bc83bf904c9be47422d2a4'),
        last: u.toHash('000000000000955887f2bbbeaf23dfa1f619ea84a8a2c81a2bf490e6c5bff25f')
      },
      {
        first: u.toHash('000000000000f270fa104d4acb8916efdedc3e926ebb40165e232e65ec8e1468'),
        last: u.toHash('000000000000af3fa8e1453ba3f16e2e2a6e38c40f76a8b84364d5129b042de6')
      },
      {
        first: u.toHash('0000000000007adc528d0c9bcaa8b59d4d74731b197e74f0245edcf3821e1d82'),
        last: u.toHash('0000000000008cc7817dcbfc514f0ab3ccca36fbdc62f7f4560a3e28bd05b886')
      }
    ]
    stream.on('data', (data) => {
      t.ok(Array.isArray(data), 'data is array')
      t.equal(data.length, 2000, 'data is correct length')
      var expected = expectedHeaders.shift()
      console.log(data[0].getId(), expected.first.toString('hex'))
      t.ok(data[0].getHash().compare(expected.first) === 0, 'got correct first header')
      t.ok(data[1999].getHash().compare(expected.last) === 0, 'got correct last header')
      if (expectedHeaders.length === 0) {
        stream.end()
        t.end()
      }
    })
  })

  t.test('disconnect', (t) => {
    pg.on('disconnect', () => {
      if (pg.peers.length === 0) {
        t.pass('all peers disconnected')
        t.end()
      }
    })
    pg.disconnect()
  })

  t.end()
})
