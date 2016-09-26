'use strict'

const httpClient = require('request-promise')
const I = require('iteray')
const jsonRpc = require('@nodeguy/json-rpc')
const R = require('ramda')
const url = require('url')
const WebSocket = require('ws')

const webSocketPipe = (socket) =>
  (input) =>
    I.toAsyncIterable((callback) => {
      const inputIterator = I.toIterator(input)

      const next = () => {
        if (socket.readyState === socket.OPEN) {
          inputIterator.next().then((result) => {
            if (result.done) {
              socket.close()
            } else {
              socket.send(result.value)
            }

            setImmediate(next)
          })
        }
      }

      socket.onclose = (event) => {
        callback(null, {done: true})
      }

      socket.onerror = callback

      socket.onmessage = (event) => {
        callback(null, {done: false, value: event.data})
      }

      socket.onopen = next
      next()
    })

const webSocketTransport = (url) =>
  R.pipe(
    I.map(JSON.stringify),
    webSocketPipe(new WebSocket(url)),
    I.map(JSON.parse)
  )

const jsonRpcToHttpRequest = (url) =>
  (request) => ({
    url,
    method: 'POST',
    json: true,
    body: request
  })

const httpToJsonRpcError = (promise) =>
  promise.catch((reason) => ({
    jsonrpc: '2.0',
    error: reason.error,
    id: reason.options.body.id
  }))

const httpTransport = (url) => R.pipe(
  I.map(R.pipe(
    jsonRpcToHttpRequest(url),
    httpClient,
    httpToJsonRpcError
  )),
  I.pullSerially
)

const transportMap = {
  'http:': httpTransport,
  'ws:': webSocketTransport
}

const transport = (url) =>
  transportMap[url.protocol](url)

// Work around Eris DB bug: https://github.com/eris-ltd/eris-db/issues/271
const convertIdToString = (request) =>
  R.assoc('id', String(request.id), request)

const addErisDbNamespace = (request) =>
  R.assoc('method', 'erisdb.' + request.method, request)

// Eris DB wants named parameters, sigh.
const positionToNamedParameters = (request) =>
  R.assoc('params', request.params[0], request)

// Work around Eris DB bug: https://github.com/eris-ltd/eris-db/issues/270
const removeNullError = (response) =>
  response.error === null
    ? R.dissoc('error', response)
    : response

const methodNames = [
  'broadcastTx',
  'call',
  'callCode',
  'eventPoll',
  'eventSubscribe',
  'eventUnsubscribe',
  'getAccount',
  'getAccounts',
  'getBlockchainInfo',
  'getChainId',
  'getClientVersion',
  'getConsensusState',
  'getGenesisHash',
  'getLatestBlock',
  'getLatestBlockHeight',
  'getListeners',
  'getMoniker',
  'getNameRegEntries',
  'getNameRegEntry',
  'getNetworkInfo',
  'getPeer',
  'getPeers',
  'genPrivAccount',
  'getStorage',
  'getStorageAt',
  'getUnconfirmedTxs',
  'getValidators',
  'isListening',
  'send',
  'sendAndHold',
  'transact',
  'transactAndHold',
  'transactNameReg'
]

const transportWrapper = (transport) => R.pipe(
  I.map(R.pipe(
    convertIdToString,
    addErisDbNamespace,
    positionToNamedParameters
  )),
  transport,
  I.map(removeNullError)
)

// Our API expects callbacks instead of promises so wrap each method.
const wrapMethod = (method) =>
  function () {
    const callback = I.get(-1, arguments)

    method.apply(null, I.slice(0, -1, arguments)).then(
      (value) => callback(null, value),
      (reason) => callback(reason)
    )
  }

module.exports = (serverUrl) => {
  const client = jsonRpc.client({
    methodNames,
    transport: transportWrapper(transport(url.parse(serverUrl)))
  })

  R.pipe(
    I.map((error) => `network transport error: ${error}`),
    I.toNodeStream
  )(client.errors).pipe(process.stderr)

  return I.map(
    (property) => [property[0], wrapMethod(property[1])],
    client.methods
  )
}