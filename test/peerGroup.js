var test = require('tap').test
var params = require('webcoin-bitcoin').net
var PeerGroup = require('../lib/peerGroup.js')

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

test('connect', (t) => {
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
    t.ok(peers.connecting, 'peer "connecting" state is now true')
  })

  t.test('disconnect from peers', (t) => {
    var i = 0
    peers.on('disconnect', (peer) => {
      i++
      t.ok(peer, 'got disconnected peer')
      t.equal(peers.peers.length, numPeers - i, 'correct number of remaining peers')
      if (i < numPeers) return
      t.equal(peers.peers.length, 0, 'disconnected from all peers')
      t.end()
    })
    peers.disconnect()
    t.notOk(peers.connecting, 'peer "connecting" state is now true')
  })

  t.end()
})
