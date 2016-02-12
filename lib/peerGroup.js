'use strict'

var EventEmitter = require('events')
var BlockStream = require('./blockStream.js')
var HeaderStream = require('./headerStream.js')
var Peer = require('./peer.js')

function assertParams (params) {
  if (!params || !params.getSeeds || params.magic == null ||
  !params.defaultPort) {
    throw new Error('Invalid network parameters')
  }
}

module.exports =
class PeerGroup extends EventEmitter {
  constructor (params, opts) {
    assertParams(params)
    super()
    this._params = params
    this._seeds = params.getSeeds({ wrtc: opts.wrtc })
    this._seeds = this._seeds.concat(opts.seeds || [])
    this._numPeers = opts.numPeers || 8
    this._getTip = opts.getTip
    this._peers = []
  }

  _error (err) {
    this.emit('error', err)
  }

  _connect () {
    var getPeer = this._seeds[Math.floor(Math.random() * this._seeds.length)]
    getPeer((err, socket) => {
      if (err) {
        this.emit('connectError', err, getPeer, null)
        return this._connect()
      }
      var peer = new Peer({
        magic: this._params.magic,
        protocolVersion: this._params.protocolVersion,
        getTip: this._getTip,
        socket
      })
      var onError = (err) => {
        err = err || new Error('Socket closed')
        this.emit('connectError', err, getPeer, peer)
        this._connect()
      }
      peer.once('error', onError)
      peer.once('disconnect', onError)
      peer.once('ready', () => {
        peer.removeListener('error', onError)
        peer.removeListener('disconnect', onError)
        this.addPeer(peer)
        this.emit('peer', peer)
      })
    })
  }

  _assertPeers () {
    if (this._peers.length === 0) {
      throw new Error('Not connected to any peers')
    }
  }

  send (command, payload) {
    this._assertPeers()
    for (var peer of this.peers) {
      peer.send(command, payload)
    }
  }

  connect (next) {
    // TODO: smarter seed logic (ensure we don't have too many peers from the
    // same seed, or the same IP block)
    var n = this._numPeers - this._peers.length
    for (var i = 0; i < n; i++) this._connect()
  }

  addPeer (peer) {
    this._peers.push(peer)
    if (this._peers.length > this._numPeers) {
      var disconnectPeer = this._peers.shift()
      disconnectPeer.disconnect()
    }

    peer.once('disconnect', () => {
      var index = this._peers.indexOf(peer)
      this._peers.splice(index, 1)
      this.emit('disconnect', peer)
    })
    peer.on('error', this._error.bind(this))
  }

  randomPeer () {
    this._assertPeers()
    return this._peers[Math.floor(Math.random() * this._peers.length)]
  }

  createHeaderStream (opts) {
    // TODO: handle peer disconnect
    return new HeaderStream(this.randomPeer(), opts)
  }

  createBlockStream (opts) {
    return new BlockStream(this, opts)
  }
}

/*
peer.on('getdata', function (message) {
  message.inventory.forEach(function (inv) {
    var hash = inv.hash.toString('base64')
    var item = self.inventory[hash]
    if (!item) return
    // TODO: handle types other than transactions
    var txMessage = peer.messages.Transaction(item.value)
    peer.sendMessage(txMessage)
  })
})
var invMessage = peer.messages.Inventory(this.getInventory())
peer.sendMessage(invMessage)

PeerGroup.prototype.setFilter = function (filter) {
  this.peers.forEach(function (peer) {
    peer.setFilter(filter)
  })
  this.filter = filter
}
PeerGroup.prototype.addToFilter = function (data) {
  this.filter.insert(data)
  this.peers.forEach(function (peer) {
    peer.addToFilter(data)
  })
}
PeerGroup.prototype.sendMessage = PeerGroup.prototype.broadcast = function (message) {
  this.peers.forEach(function (peer) {
    peer.sendMessage(message)
  })
}
*/
