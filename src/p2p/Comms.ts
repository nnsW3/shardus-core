import * as utils from '../utils'
import { crypto, logger, network, config } from './Context'
import { Logger } from 'log4js'
import * as Self from './Self'
import * as NodeList from './NodeList'
import * as Sync from './Sync'
import { InternalHandler, LooseObject } from './Types'

/** TYPES */


/** ROUTES */

type GossipReq = LooseObject

const gossipInternalRoute: InternalHandler<GossipReq> = async (payload, _respond, sender, tracker) => {
  await handleGossip(payload, sender, tracker)
}

const routes = {
  internal: {
    'gossip': gossipInternalRoute
  },
}
/** STATE */

let mainLogger: Logger
let fatalLogger: Logger
let verboseLogs: boolean

let acceptInternal = false

let keyCounter = 0
let internalRecvCounter = 0
const gossipedHashesSent = new Map()
const gossipedHashes = new Map()
const gossipHandlers = {}

/** FUNCTIONS */
export function setAcceptInternal(enabled: boolean) {
  acceptInternal = enabled
}

export function init() {
  mainLogger = logger.getLogger('main')
  fatalLogger = logger.getLogger('fatal')

  // Register routes
  for (const [name, handler] of Object.entries(routes.internal)) {
    registerInternal(name, handler)
  }
}

export function setVerboseLogs(enabled: boolean) {
  verboseLogs = enabled
}

// Finds a node either in nodelist or in seedNodes list
function _findNodeInGroup(nodeId, group) {
  if (!group) {
    const errMsg = 'No group given for _findNodeInGroup()'
    mainLogger.debug(errMsg)
    throw new Error(errMsg)
  }
  mainLogger.debug(`Node ID to find in group: ${nodeId}`)
  for (const node of group) {
    if (node.id === nodeId) return node
  }
  return false
}

// Verifies that the received internal message was signed by the stated node
function _authenticateByNode(message, node) {
  let result
  try {
    if (!node.curvePublicKey) {
      mainLogger.debug(
        'Node object did not contain curve public key for authenticateByNode()!'
      )
      return false
    }
    mainLogger.debug(`Expected publicKey: ${node.curvePublicKey}`)
    result = crypto.authenticate(message, node.curvePublicKey)
  } catch (e) {
    mainLogger.debug(
      `Invalid or missing authentication tag on message: ${JSON.stringify(
        message
      )}`
    )
    return false
  }
  return result
}

function _extractPayload(wrappedPayload, nodeGroup) {
  if (wrappedPayload.error) {
    const error = wrappedPayload.error
    mainLogger.debug(
      `_extractPayload Failed to extract payload. Error: ${error}`
    )
    return [null]
  }
  // Check to see if node is in expected node group
  const node = _findNodeInGroup(wrappedPayload.sender, nodeGroup)
  if (!node) {
    mainLogger.debug(
      `_extractPayload Invalid sender on internal payload. sender: ${
        wrappedPayload.sender
      } payload: ${utils.stringifyReduceLimit(wrappedPayload)}`
    )
    return [null]
  }
  const authenticatedByNode = _authenticateByNode(wrappedPayload, node)
  // Check if actually signed by that node
  if (!authenticatedByNode) {
    mainLogger.debug(
      '_extractPayload Internal payload not authenticated by an expected node.'
    )
    return [null]
  }
  const payload = wrappedPayload.payload
  const sender = wrappedPayload.sender
  const tracker = wrappedPayload.tracker
  mainLogger.debug('Internal payload successfully authenticated.')
  return [payload, sender, tracker]
}

function _wrapAndTagMessage(msg, tracker = '', recipientNode) {
  if (!msg) throw new Error('No message given to wrap and tag!')
  if (verboseLogs) {
    mainLogger.debug(
      `Attaching sender ${Self.id} to the message: ${utils.stringifyReduceLimit(
        msg
      )}`
    )
  }
  const wrapped = {
    payload: msg,
    sender: Self.id,
    tracker,
  }
  const tagged = crypto.tag(wrapped, recipientNode.curvePublicKey)
  return tagged
}

function createMsgTracker() {
  return (
    'key_' +
    utils.makeShortHash(Self.id) +
    '_' +
    Date.now() +
    '_' +
    keyCounter++
  )
}
function createGossipTracker() {
  return (
    'gkey_' +
    utils.makeShortHash(Self.id) +
    '_' +
    Date.now() +
    '_' +
    keyCounter++
  )
}

// Our own P2P version of the network tell, with a sign added
export async function tell(nodes, route, message, logged = false, tracker = '') {
  if (tracker === '') {
    tracker = createMsgTracker()
  }
  const promises = []
  for (const node of nodes) {
    if (node.id === Self.id) {
      mainLogger.info('p2p/Comms:tell: Not telling self')
      continue
    }
    const signedMessage = _wrapAndTagMessage(message, tracker, node)
    promises.push(network.tell([node], route, signedMessage, logged))
  }
  try {
    await Promise.all(promises)
  } catch (err) {
    mainLogger.debug('P2P TELL: failed', err)
  }
}

// Our own P2P version of the network ask, with a sign added, and sign verified on other side
export async function ask(
  node,
  route: string,
  message = {},
  logged = false,
  tracker = ''
) {
  if (tracker === '') {
    tracker = createMsgTracker()
  }
  if (node.id === Self.id) {
    mainLogger.info('p2p/Comms:ask: Not asking self')
    return false
  }
  const signedMessage = _wrapAndTagMessage(message, tracker, node)
  let signedResponse
  try {
    signedResponse = await network.ask(node, route, signedMessage, logged)
  } catch (err) {
    mainLogger.error('P2P: ask: network.ask: ' + err)
    return false
  }
  mainLogger.debug(
    `Result of network-level ask: ${JSON.stringify(signedResponse)}`
  )
  try {
    const [response] = _extractPayload(signedResponse, [node])
    if (!response) {
      throw new Error(
        `Unable to verify response to ask request: ${route} -- ${JSON.stringify(
          message
        )} from node: ${node.id}`
      )
    }
    return response
  } catch (err) {
    mainLogger.error('P2P: ask: _extractPayload: ' + err)
    return false
  }
}

export function registerInternal(route, handler) {
  // Create function that wraps handler function
  const wrappedHandler = async (wrappedPayload, respond) => {
    internalRecvCounter++
    // We have internal requests turned off until we have a node id
    if (!acceptInternal) {
      mainLogger.debug(
        'We are not currently accepting internal requests...'
      )
      return
    }
    let tracker = ''
    // Create wrapped respond function for sending back signed data
    const respondWrapped = async response => {
      const node = NodeList.nodes.get(sender)
      const signedResponse = _wrapAndTagMessage(response, tracker, node)
      if (verboseLogs) {
        mainLogger.debug(
          `The signed wrapped response to send back: ${utils.stringifyReduceLimit(
            signedResponse
          )}`
        )
      }
      if (route !== 'gossip') {
        logger.playbackLog(
          sender,
          'self',
          'InternalRecvResp',
          route,
          tracker,
          response
        )
      }
      await respond(signedResponse)
    }
    // Checks to see if we can extract the actual payload from the wrapped message
    const payloadArray = _extractPayload(
      wrappedPayload,
      NodeList.byJoinOrder
    )
    const [payload, sender] = payloadArray
    tracker = payloadArray[2] || ''
    if (!payload) {
      mainLogger.debug(
        'Payload unable to be extracted, possible missing signature...'
      )
      return
    }
    if (route !== 'gossip') {
      logger.playbackLog(
        sender,
        'self',
        'InternalRecv',
        route,
        tracker,
        payload
      )
    }
    await handler(payload, respondWrapped, sender, tracker)
  }
  // Include that in the handler function that is passed
  network.registerInternal(route, wrappedHandler)
}

export function unregisterInternal(route) {
  network.unregisterInternal(route)
}

/**
 * Send Gossip to all nodes
 */
export async function sendGossip(
  type,
  payload,
  tracker = '',
  sender = null,
  nodes = NodeList.byJoinOrder
) {
  if (nodes.length === 0) return

  if (tracker === '') {
    tracker = createGossipTracker()
  }

  if (verboseLogs) {
    mainLogger.debug(
      `Start of sendGossip(${utils.stringifyReduce(payload)})`
    )
  }
  const gossipPayload = { type, data: payload }

  const gossipHash = crypto.hash(gossipPayload)
  if (gossipedHashesSent.has(gossipHash)) {
    if (verboseLogs) {
      mainLogger.debug(
        `Gossip already sent: ${gossipHash.substring(0, 5)}`
      )
    }
    return
  }

  // [TODO] pass getRandomGossipIn hash of payload
  let recipients = utils.getRandom(nodes, config.p2p.gossipRecipients)
  if (sender != null) {
    recipients = utils.removeNodesByID(recipients, [sender])
  }
  try {
    if (verboseLogs) {
      mainLogger.debug(
        `Gossiping ${type} request to these nodes: ${utils.stringifyReduce(
          recipients.map(
            node => utils.makeShortHash(node.id) + ':' + node.externalPort
          )
        )}`
      )
    }
    for (const node of recipients) {
      logger.playbackLog(
        'self',
        node,
        'GossipSend',
        type,
        tracker,
        gossipPayload
      )
    }
    await tell(recipients, 'gossip', gossipPayload, true, tracker)
  } catch (ex) {
    if (verboseLogs) {
      mainLogger.error(
        `Failed to sendGossip(${utils.stringifyReduce(
          payload
        )}) Exception => ${ex}`
      )
    }
    fatalLogger.fatal(
      'sendGossip: ' + ex.name + ': ' + ex.message + ' at ' + ex.stack
    )
  }
  gossipedHashesSent.set(gossipHash, false)
  if (verboseLogs) {
    mainLogger.debug(
      `End of sendGossip(${utils.stringifyReduce(payload)})`
    )
  }
}

function sortByID(first, second) {
  return utils.sortAscProp(first, second, 'id')
}

/**
 * Send Gossip to all nodes, using gossip in
 */
export async function sendGossipIn(
  type,
  payload,
  tracker = '',
  sender = null,
  nodes = NodeList.byJoinOrder
) {
  if (nodes.length === 0) return

  if (tracker === '') {
    tracker = createGossipTracker()
  }

  if (verboseLogs) {
    mainLogger.debug(
      `Start of sendGossipIn(${utils.stringifyReduce(payload)})`
    )
  }
  const gossipPayload = { type, data: payload }

  const gossipHash = crypto.hash(gossipPayload)
  if (gossipedHashesSent.has(gossipHash)) {
    if (verboseLogs) {
      mainLogger.debug(
        `Gossip already sent: ${gossipHash.substring(0, 5)}`
      )
    }
    return
  }
  // nodes.sort((first, second) => first.id.localeCompare(second.id, 'en', { sensitivity: 'variant' }))
  nodes.sort(sortByID)
  const nodeIdxs = new Array(nodes.length).fill(0).map((curr, idx) => idx)
  // Find out your own index in the nodes array
  const myIdx = nodes.findIndex(node => node.id === Self.id)
  if (myIdx < 0) throw new Error('Could not find self in nodes array')
  // Map back recipient idxs to node objects
  const recipientIdxs = utils.getRandomGossipIn(
    nodeIdxs,
    config.p2p.gossipRecipients,
    myIdx
  )
  let recipients = recipientIdxs.map(idx => nodes[idx])
  if (sender != null) {
    recipients = utils.removeNodesByID(recipients, [sender])
  }
  try {
    if (verboseLogs) {
      mainLogger.debug(
        `GossipingIn ${type} request to these nodes: ${utils.stringifyReduce(
          recipients.map(
            node => utils.makeShortHash(node.id) + ':' + node.externalPort
          )
        )}`
      )
    }
    for (const node of recipients) {
      logger.playbackLog(
        'self',
        node.id,
        'GossipInSend',
        type,
        tracker,
        gossipPayload
      )
    }
    await tell(recipients, 'gossip', gossipPayload, true, tracker)
  } catch (ex) {
    if (verboseLogs) {
      mainLogger.error(
        `Failed to sendGossip(${utils.stringifyReduce(
          payload
        )}) Exception => ${ex}`
      )
    }
    fatalLogger.fatal(
      'sendGossipIn: ' + ex.name + ': ' + ex.message + ' at ' + ex.stack
    )
  }
  gossipedHashesSent.set(gossipHash, false)
  if (verboseLogs) {
    mainLogger.debug(
      `End of sendGossipIn(${utils.stringifyReduce(payload)})`
    )
  }
}

/**
 * Send Gossip to all nodes in this list, special case broadcast, never use this for regular gossip.
 */
export async function sendGossipAll(
  type,
  payload,
  tracker = '',
  sender = null,
  nodes = NodeList.byJoinOrder
) {
  if (nodes.length === 0) return

  if (tracker === '') {
    tracker = createGossipTracker()
  }

  if (verboseLogs) {
    mainLogger.debug(
      `Start of sendGossipIn(${utils.stringifyReduce(payload)})`
    )
  }
  const gossipPayload = { type, data: payload }

  const gossipHash = crypto.hash(gossipPayload)
  if (gossipedHashesSent.has(gossipHash)) {
    if (verboseLogs) {
      mainLogger.debug(
        `Gossip already sent: ${gossipHash.substring(0, 5)}`
      )
    }
    return
  }
  // Find out your own index in the nodes array
  const myIdx = nodes.findIndex(node => node.id === Self.id)
  if (myIdx < 0) throw new Error('Could not find self in nodes array')
  // Map back recipient idxs to node objects
  let recipients = nodes
  if (sender != null) {
    recipients = utils.removeNodesByID(recipients, [sender])
  }
  try {
    if (verboseLogs) {
      mainLogger.debug(
        `GossipingIn ${type} request to these nodes: ${utils.stringifyReduce(
          recipients.map(
            node => utils.makeShortHash(node.id) + ':' + node.externalPort
          )
        )}`
      )
    }
    for (const node of recipients) {
      logger.playbackLog(
        'self',
        node.id,
        'GossipInSendAll',
        type,
        tracker,
        gossipPayload
      )
    }
    await tell(recipients, 'gossip', gossipPayload, true, tracker)
  } catch (ex) {
    if (verboseLogs) {
      mainLogger.error(
        `Failed to sendGossip(${utils.stringifyReduce(
          payload
        )}) Exception => ${ex}`
      )
    }
    fatalLogger.fatal(
      'sendGossipIn: ' + ex.name + ': ' + ex.message + ' at ' + ex.stack
    )
  }
  gossipedHashesSent.set(gossipHash, false)
  if (verboseLogs) {
    mainLogger.debug(
      `End of sendGossipIn(${utils.stringifyReduce(payload)})`
    )
  }
}

/**
 * Handle Goosip Transactions
 * Payload: {type: ['receipt', 'trustedTransaction'], data: {}}
 */
export async function handleGossip(payload, sender, tracker = '') {
  if (verboseLogs) {
    mainLogger.debug(
      `Start of handleGossip(${utils.stringifyReduce(payload)})`
    )
  }
  const type = payload.type
  const data = payload.data

  const gossipHandler = gossipHandlers[type]
  if (!gossipHandler) {
    mainLogger.debug(`Gossip Handler not found: type ${type}, data: ${JSON.stringify(data)}`)
    return
  }

  const gossipHash = crypto.hash(payload)
  if (gossipedHashesSent.has(gossipHash)) {
    return
  }

  if (gossipedHashes.has(gossipHash)) {
    if (verboseLogs) {
      mainLogger.debug(`Got old gossip: ${gossipHash.substring(0, 5)}`)
    }
    if (!gossipedHashes.get(gossipHash)) {
      setTimeout(
        () => gossipedHashes.delete(gossipHash),
        config.p2p.gossipTimeout
      )
      gossipedHashes.set(gossipHash, true)
      if (verboseLogs) {
        mainLogger.debug(
          `Marked old gossip for deletion: ${gossipHash.substring(0, 5)} in ${
            config.p2p.gossipTimeout
          } ms`
        )
      }
    }
    return
  }
  gossipedHashes.set(gossipHash, false)
  logger.playbackLog(sender, 'self', 'GossipRcv', type, tracker, data)
  await gossipHandler(data, sender, tracker)
  if (verboseLogs) {
    mainLogger.debug(
      `End of handleGossip(${utils.stringifyReduce(payload)})`
    )
  }
}

/**
 * Callback for handling gossip.
 *
 * @callback handleGossipCallback
 * @param {any} data the data response of the callback
 * @param {Node} sender
 * @param {string} tracker the tracking string
 */

/**
 * @param {string} type
 * @param {handleGossipCallback} handler
 */
export function registerGossipHandler(type, handler) {
  gossipHandlers[type] = handler
}

export function unregisterGossipHandler(type) {
  if (gossipHandlers[type]) {
    delete gossipHandlers[type]
  }
}
