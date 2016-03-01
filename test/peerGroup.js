var test = require('tap').test
var params = require('webcoin-bitcoin')
var u = require('bitcoin-util')
var Block = require('bitcoinjs-lib').Block
var Blockchain = require('blockchain-spv')
var levelup = require('levelup')
var memdown = require('memdown')
var PeerGroup = require('../lib/peerGroup.js')
var HeaderStream = require('../lib/headerStream.js')
var BlockStream = require('../lib/blockStream.js')

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
    var peers = new PeerGroup(params.net)
    t.ok(peers, 'created PeerGroup')
    t.end()
  })

  t.test('valid params, with options', (t) => {
    var peers = new PeerGroup(params.net, { numPeers: 4 })
    t.ok(peers, 'created PeerGroup')
    t.end()
  })

  t.end()
})

test('connect, disconnect', (t) => {
  // NOTE: this test connects to real nodes
  var numPeers = 8
  var peers = new PeerGroup(params.net, { numPeers })

  t.test('connect to peers', (t) => {
    var onPeer = (peer) => {
      t.ok(peer, 'got peer')
      t.ok(peer.ready, 'peer has completed handshake')
      t.equal(peer.magic, params.net.magic, 'correct magic bytes')
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
  var pg = new PeerGroup(params.net, { numPeers })

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

  var chain
  t.test('setup blockchain', (t) => {
    var db = levelup('chain', { db: memdown })
    var blockchainParams = Object.assign({}, params.blockchain)
    blockchainParams.checkpoints = null
    chain = new Blockchain(blockchainParams, db)
    chain.once('ready', () => t.end())
  })

  t.test('createHeaderStream', (t) => {
    var expectedHeaders = [
      {
        first: u.toHash('00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048'),
        last: u.toHash('00000000dfd5d65c9d8561b4b8f60a63018fe3933ecb131fb37f905f87da951a')
      },
      {
        first: u.toHash('0000000067217a46c49054bad67cda2da943607d326e89896786de10b07cb7c0'),
        last: u.toHash('00000000922e2aa9e84a474350a3555f49f06061fd49df50a9352f156692a842')
      },
      {
        first: u.toHash('00000000a86f68e8de06c6b46623fdd16b7a11ad9651fa48ecbe8c731658dc06'),
        last: u.toHash('00000000dbbb79792303bdd1c6c4d7ab9c21bba0667213c2eca955e11230c5a5')
      },
      {
        first: u.toHash('0000000055fcaf04cb9a82bb86b46a21b15fcaa75ac8c18679b0234f79c4c615'),
        last: u.toHash('0000000094fbacdffec05aea9847000522a258c269ae37a74a818afb96fc27d9')
      }
    ]
    var start = u.toHash('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f')
    var stream = pg.createHeaderStream({ locator: [ start ] })
    t.ok(stream instanceof HeaderStream, 'got HeaderStream')
    stream.on('data', (data) => {
      t.ok(Array.isArray(data), 'data is array')
      t.equal(data.length, 2000, 'data is correct length')
      t.ok(data[0] instanceof Block, 'data contains block headers (bitcoinjs Block)')
      var expected = expectedHeaders.shift()
      t.ok(data[0].getHash().compare(expected.first) === 0, 'got correct first header')
      t.ok(data[1999].getHash().compare(expected.last) === 0, 'got correct last header')
      chain.addHeaders(data, (err) => {
        t.error(err, 'headers add to blockchain')
        if (expectedHeaders.length === 0) {
          stream.end()
          t.end()
        }
      })
    })
  })

  // t.test('createBlockStream', (t) => {
  //   var stream = pg.createBlockStream(chain, { from: chain.genesis.hash })
  //   t.ok(stream instanceof BlockStream, 'got BlockStream')
  //   var lastHeight = 0
  //   var lastHash = chain.genesis.hash
  //   stream.on('data', (data) => {
  //     t.equal(typeof data.height, 'number', 'data contains height')
  //     t.ok(data.header instanceof Block, 'data contains header (bitcoinjs Block)')
  //     t.equal(data.height, lastHeight + 1, 'blocks ordered by height')
  //     t.ok(data.header.prevHash.compare(lastHash) === 0, 'block connects to previous hash')
  //     lastHeight++
  //     lastHash = data.header.getHash()
  //   })
  //   stream.on('end', () => t.end())
  // })

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
