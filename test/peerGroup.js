'use strict'

const tape = require('tape')
const params = require('webcoin-bitcoin')
const Blockchain = require('blockchain-spv')
const levelup = require('levelup')
const memdown = require('memdown')
const PeerGroup = require('../').PeerGroup
const wrtc = require('wrtc')
const { getTxHash } = require('../src/utils.js')

var test = (name, opts, f) => {
  if (typeof opts === 'function') {
    f = opts
    opts = {}
  }
  // really high default timeout
  if (opts.timeout == null) opts.timeout = 5 * 60 * 1000
  return tape(name, opts, f)
}

test('PeerGroup constructor', (t) => {
  t.test('invalid params', (t) => {
    try {
      var peers = new PeerGroup({}, { wrtc })
      t.fail('should have thrown')
      t.notOk(peers)
    } catch (err) {
      t.ok(err, 'error thrown')
      t.equal(err.message, 'Invalid network parameters', 'correct error message')
      t.end()
    }
  })

  t.test('valid params, connectWeb opt but no wrtc', (t) => {
    var peers
    if (process.browser) {
      peers = new PeerGroup(params.net, { connectWeb: true })
      t.ok(peers, 'no error thrown')
      t.end()
    } else {
      try {
        peers = new PeerGroup(params.net, { connectWeb: true })
        t.fail('should have thrown')
        t.notOk(peers)
      } catch (err) {
        t.ok(err, 'error thrown')
        t.equal(err.message, 'No WebRTC implementation found, please pass one in  as the "wrtc" option (for example, the "wrtc" or "electron-webrtc" packages).', 'correct error message')
        t.end()
      }
    }
  })

  t.test('valid params, no opts', (t) => {
    var peers = new PeerGroup(params.net)
    t.ok(peers, 'no error thrown')
    t.end()
  })

  t.test('valid params, with options', (t) => {
    var peers = new PeerGroup(params.net, { numPeers: 4, wrtc })
    t.ok(peers, 'created PeerGroup')
    t.end()
  })

  t.end()
})

var numPeers = 2
var pg
test('connect', (t) => {
  // NOTE: these tests connects to real nodes
  pg = new PeerGroup(params.net, { numPeers, wrtc })

  var onPeer = (peer) => {
    t.ok(peer, 'got peer')
    t.ok(peer.ready, 'peer has completed handshake')
    t.ok(peer.socket.readable, 'peer transport socket is readable')
    t.ok(peer.socket.writable, 'peer transport socket is writable')
    if (pg.peers.length < numPeers) return
    t.pass('connected to `numPeers` peers')
    pg.removeListener('peer', onPeer)
    t.end()
  }
  pg.on('peer', onPeer)
  pg.connect()
  t.ok(pg.connecting, 'pg "connecting" state is true')
})

test('peer methods', (t) => {
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

  t.test('getBlocks', (t) => {
    var hash = Buffer.from('6a4690e6ba50e286b8c63c826399a6ac73be3f479f17406cdf90468700000000', 'hex')
    pg.getBlocks([ hash ], (err, res) => {
      t.pass('callback called')
      t.error(err, 'no error')
      t.ok(Array.isArray(res), 'result is array')
      t.equal(res.length, 1, 'result is correct length')
      t.equal(res[0].header.nonce, 1766761990, 'header has correct nonce')
      t.ok(Array.isArray(res[0].transactions), 'result has transactions array')
      t.equal(res[0].transactions.length, 1, 'transactions array is correct length')
      t.true(getTxHash(res[0].transactions[0]).equals(Buffer.from('3797c09006aaad367f7342e215820e499bfbb809f042c690fb7a71b8537c0868', 'hex').reverse()), 'transaction has correct hash')
      t.end()
    })
  })

  var chain
  t.test('setup blockchain', (t) => {
    var db = levelup('chain', { db: memdown })
    chain = new Blockchain(params.blockchain, db, { ignoreCheckpoints: true })
    chain.once('ready', () => t.end())
  })

  t.end()
})

test('close', (t) => {
  var i = 0
  var startPeers = pg.peers.length
  pg.on('disconnect', (peer) => {
    t.ok(pg.closed, 'pg "closed" state is true')
    i++
    t.ok(peer, 'got disconnected peer')
    t.equal(pg.peers.length, startPeers - i, 'correct number of remaining peers')
  })
  pg.close((err) => {
    t.pass('close listener called')
    t.error(err, 'no error')
    t.equal(pg.peers.length, 0, 'disconnected from all peers')
    t.end()
  })
})
