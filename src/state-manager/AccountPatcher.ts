import * as Shardus from '../shardus/shardus-types'
import { StateManager as StateManagerTypes } from '@shardus/types'
import * as utils from '../utils'
import Profiler, { profilerInstance } from '../utils/profiler'
import { P2PModuleContext as P2P } from '../p2p/Context'
import Crypto, { HashableObject } from '../crypto'
import Logger, { logFlags } from '../logger'
import log4js from 'log4js'
import ShardFunctions from './shardFunctions'
import StateManager from '.'
import { nestedCountersInstance } from '../utils/nestedCounters'
import * as NodeList from '../p2p/NodeList'
import * as Context from '../p2p/Context'
import * as Wrapper from '../p2p/Wrapper'
import {
  AccountHashCache,
  AccountHashCacheHistory,
  AccountIDAndHash,
  AccountPreTest,
  HashTrieAccountDataRequest,
  HashTrieAccountDataResponse,
  HashTrieAccountsResp,
  HashTrieNode,
  HashTrieRadixCoverage,
  HashTrieReq,
  HashTrieResp,
  HashTrieSyncConsensus,
  HashTrieSyncTell,
  HashTrieUpdateStats,
  RadixAndChildHashes,
  RadixAndHash,
  ShardedHashTrie,
  TrieAccount,
  CycleShardData,
} from './state-manager-types'
import { isDebugModeMiddleware } from '../network/debugMiddleware'
import { errorToStringFull, Ordering } from '../utils'
import { Response } from 'express-serve-static-core'
import { shardusGetTime } from '../network'

type Line = {
  raw: string
  file: {
    owner: string
  }
}
type AccountHashStats = {
  matched: number
  visisted: number
  empty: number
  nullResults: number
  numRequests: number
  responses: number
  exceptions: number
  radixToReq: number
  actualRadixRequests: number
}

type AccountStats = {
  skipping: number
  multiRequests: number
  requested: number
}

class AccountPatcher {
  app: Shardus.App
  crypto: Crypto
  config: Shardus.StrictServerConfiguration
  profiler: Profiler

  p2p: P2P

  logger: Logger

  mainLogger: log4js.Logger
  fatalLogger: log4js.Logger
  shardLogger: log4js.Logger
  statsLogger: log4js.Logger

  statemanager_fatal: (key: string, log: string) => void
  stateManager: StateManager

  treeMaxDepth: number
  treeSyncDepth: number
  shardTrie: ShardedHashTrie

  totalAccounts: number

  accountUpdateQueue: TrieAccount[]
  accountUpdateQueueFuture: TrieAccount[]

  accountRemovalQueue: string[]

  hashTrieSyncConsensusByCycle: Map<number, HashTrieSyncConsensus>

  incompleteNodes: HashTrieNode[]

  debug_ignoreUpdates: boolean

  failedLastTrieSync: boolean
  failStartCycle: number
  failEndCycle: number
  failRepairsCounter: number
  syncFailHistory: { s: number; e: number; cycles: number; repaired: number }[]

  sendHashesToEdgeNodes: boolean

  lastCycleNonConsensusRanges: { low: string; high: string }[]

  nonStoredRanges: { low: string; high: string }[]
  radixIsStored: Map<string, boolean>

  lastRepairInfo: unknown

  constructor(
    stateManager: StateManager,
    profiler: Profiler,
    app: Shardus.App,
    logger: Logger,
    p2p: P2P,
    crypto: Crypto,
    config: Shardus.StrictServerConfiguration
  ) {
    this.crypto = crypto
    this.app = app
    this.logger = logger
    this.config = config
    this.profiler = profiler
    this.p2p = p2p

    if (logger == null) {
      return // for debug
    }

    this.mainLogger = logger.getLogger('main')
    this.fatalLogger = logger.getLogger('fatal')
    this.shardLogger = logger.getLogger('shardDump')
    this.statsLogger = logger.getLogger('statsDump')
    this.statemanager_fatal = stateManager.statemanager_fatal
    this.stateManager = stateManager

    //todo these need to be dynamic
    this.treeMaxDepth = 4
    this.treeSyncDepth = 1

    this.shardTrie = {
      layerMaps: [],
    }
    //init or update layer maps. (treeMaxDepth doesn't count root so +1 it)
    for (let i = 0; i < this.treeMaxDepth + 1; i++) {
      this.shardTrie.layerMaps.push(new Map())
    }

    this.totalAccounts = 0

    this.hashTrieSyncConsensusByCycle = new Map()

    this.incompleteNodes = []

    this.accountUpdateQueue = []
    this.accountUpdateQueueFuture = []
    this.accountRemovalQueue = []

    this.debug_ignoreUpdates = false

    this.failedLastTrieSync = false

    this.sendHashesToEdgeNodes = true

    this.lastCycleNonConsensusRanges = []
    this.nonStoredRanges = []
    this.radixIsStored = new Map()

    this.lastRepairInfo = 'none'

    this.failStartCycle = -1
    this.failEndCycle = -1
    this.failRepairsCounter = 0
    this.syncFailHistory = []
  }

  hashObj(value: HashableObject): string {
    //could replace with a different cheaper hash!!
    return this.crypto.hash(value)
  }
  sortByAccountID(a: TrieAccount, b: TrieAccount): Ordering {
    if (a.accountID < b.accountID) {
      return -1
    }
    if (a.accountID > b.accountID) {
      return 1
    }
    return 0
  }
  sortByRadix(a: RadixAndHash, b: RadixAndHash): Ordering {
    if (a.radix < b.radix) {
      return -1
    }
    if (a.radix > b.radix) {
      return 1
    }
    return 0
  }

  /***
   *    ######## ##    ## ########  ########   #######  #### ##    ## ########  ######
   *    ##       ###   ## ##     ## ##     ## ##     ##  ##  ###   ##    ##    ##    ##
   *    ##       ####  ## ##     ## ##     ## ##     ##  ##  ####  ##    ##    ##
   *    ######   ## ## ## ##     ## ########  ##     ##  ##  ## ## ##    ##     ######
   *    ##       ##  #### ##     ## ##        ##     ##  ##  ##  ####    ##          ##
   *    ##       ##   ### ##     ## ##        ##     ##  ##  ##   ###    ##    ##    ##
   *    ######## ##    ## ########  ##         #######  #### ##    ##    ##     ######
   */

  setupHandlers(): void {
    this.p2p.registerInternal(
      'get_trie_hashes',
      async (
        payload: HashTrieReq,
        respond: (arg0: HashTrieResp) => Promise<number>,
        _sender: unknown,
        _tracker: string,
        msgSize: number
      ) => {
        profilerInstance.scopedProfileSectionStart('get_trie_hashes', false, msgSize)
        const result = { nodeHashes: [] } as HashTrieResp
        let responseCount = 0
        for (const radix of payload.radixList) {
          const level = radix.length
          const layerMap = this.shardTrie.layerMaps[level] // eslint-disable-line security/detect-object-injection
          if (layerMap == null) {
            /* prettier-ignore */ nestedCountersInstance.countEvent('accountPatcher', `get_trie_hashes badrange:${level}`)
            break
          }

          const hashTrieNode = layerMap.get(radix)
          if (hashTrieNode != null) {
            for (const childTreeNode of hashTrieNode.children) {
              if (childTreeNode != null) {
                result.nodeHashes.push({ radix: childTreeNode.radix, hash: childTreeNode.hash })
                responseCount++
              }
            }
          }
        }

        /* prettier-ignore */ nestedCountersInstance.countEvent('accountPatcher', `get_trie_hashes c:${this.stateManager.currentCycleShardData.cycleNumber}`, responseCount)

        // todo could recored a split time here.. so we know time spend on handling the request vs sending the response?
        // that would not be completely accurate because the time to get the data is outide of this handler...
        const respondSize = await respond(result)
        profilerInstance.scopedProfileSectionEnd('get_trie_hashes', respondSize)
      }
    )

    this.p2p.registerInternal(
      'sync_trie_hashes',
      async (
        payload: HashTrieSyncTell,
        _respondWrapped: unknown,
        sender: string,
        _tracker: string,
        msgSize: number
      ) => {
        profilerInstance.scopedProfileSectionStart('sync_trie_hashes', false, msgSize)
        try {
          //TODO use our own definition of current cycle.
          //use playlod cycle to filter out TXs..
          const cycle = payload.cycle

          let hashTrieSyncConsensus = this.hashTrieSyncConsensusByCycle.get(payload.cycle)
          if (hashTrieSyncConsensus == null) {
            hashTrieSyncConsensus = {
              cycle: payload.cycle,
              radixHashVotes: new Map(),
              coverageMap: new Map(),
            }
            this.hashTrieSyncConsensusByCycle.set(payload.cycle, hashTrieSyncConsensus)

            const shardValues = this.stateManager.shardValuesByCycle.get(payload.cycle)
            if (shardValues == null) {
              /* prettier-ignore */ nestedCountersInstance.countEvent('accountPatcher', `sync_trie_hashes not ready c:${payload.cycle}`)
              return
            }

            //mark syncing radixes..
            //todo compare to cycle!! only init if from current cycle.
            this.initStoredRadixValues(payload.cycle)
          }

          const node = NodeList.nodes.get(sender)

          for (const nodeHashes of payload.nodeHashes) {
            //don't record the vote if we cant use it!
            // easier than filtering it out later on in the stream.
            if (this.isRadixStored(cycle, nodeHashes.radix) === false) {
              continue
            }

            //todo: secure that the voter is allowed to vote.
            let hashVote = hashTrieSyncConsensus.radixHashVotes.get(nodeHashes.radix)
            if (hashVote == null) {
              hashVote = { allVotes: new Map(), bestHash: nodeHashes.hash, bestVotes: 1 }
              hashTrieSyncConsensus.radixHashVotes.set(nodeHashes.radix, hashVote)
              hashVote.allVotes.set(nodeHashes.hash, { count: 1, voters: [node] })
            } else {
              const voteEntry = hashVote.allVotes.get(nodeHashes.hash)
              if (voteEntry == null) {
                hashVote.allVotes.set(nodeHashes.hash, { count: 1, voters: [node] })
              } else {
                const voteCount = voteEntry.count + 1
                voteEntry.count = voteCount
                voteEntry.voters.push(node)
                //hashVote.allVotes.set(nodeHashes.hash, votes + 1)
                //will ties be a problem? (not if we need a majority!)
                if (voteCount > hashVote.bestVotes) {
                  hashVote.bestVotes = voteCount
                  hashVote.bestHash = nodeHashes.hash
                }
              }
            }
          }
        } finally {
          profilerInstance.scopedProfileSectionEnd('sync_trie_hashes')
        }
      }
    )

    //get child accountHashes for radix.  //get the hashes and ids so we know what to fix.
    this.p2p.registerInternal(
      'get_trie_accountHashes',
      async (
        payload: HashTrieReq,
        respond: (arg0: HashTrieAccountsResp) => Promise<number>,
        _sender: string,
        _tracker: string,
        msgSize: number
      ) => {
        profilerInstance.scopedProfileSectionStart('get_trie_accountHashes', false, msgSize)
        //nodeChildHashes: {radix:string, childAccounts:{accountID:string, hash:string}[]}[]
        const result = {
          nodeChildHashes: [],
          stats: { matched: 0, visisted: 0, empty: 0, childCount: 0 },
        } as HashTrieAccountsResp

        const patcherMaxChildHashResponses = this.config.stateManager.patcherMaxChildHashResponses

        for (const radix of payload.radixList) {
          result.stats.visisted++
          const level = radix.length
          const layerMap = this.shardTrie.layerMaps[level] // eslint-disable-line security/detect-object-injection
          if (layerMap == null) {
            /* prettier-ignore */ nestedCountersInstance.countEvent('accountPatcher', `get_trie_accountHashes badrange:${level}`)
            break
          }

          const hashTrieNode = layerMap.get(radix)
          if (hashTrieNode != null && hashTrieNode.accounts != null) {
            result.stats.matched++
            const childAccounts = []
            result.nodeChildHashes.push({ radix, childAccounts })
            for (const account of hashTrieNode.accounts) {
              childAccounts.push({ accountID: account.accountID, hash: account.hash })
              result.stats.childCount++
            }
            if (hashTrieNode.accounts.length === 0) {
              result.stats.empty++
            }
          }

          //some protection on how many responses we can send
          if (result.stats.childCount > patcherMaxChildHashResponses) {
            break
          }
        }

        /* prettier-ignore */ nestedCountersInstance.countEvent('accountPatcher', `get_trie_accountHashes c:${this.stateManager.currentCycleShardData.cycleNumber}`, result.stats.childCount)

        const respondSize = await respond(result)
        profilerInstance.scopedProfileSectionEnd('get_trie_accountHashes', respondSize)
      }
    )

    this.p2p.registerInternal(
      'get_account_data_by_hashes',
      async (
        payload: HashTrieAccountDataRequest,
        respond: (arg0: HashTrieAccountDataResponse) => Promise<number>,
        _sender: string,
        _tracker: string,
        msgSize: number
      ) => {
        profilerInstance.scopedProfileSectionStart('get_account_data_by_hashes', false, msgSize)
        nestedCountersInstance.countEvent('accountPatcher', `get_account_data_by_hashes`)
        const result: HashTrieAccountDataResponse = { accounts: [], stateTableData: [] }
        try {
          //nodeChildHashes: {radix:string, childAccounts:{accountID:string, hash:string}[]}[]
          const queryStats = {
            fix1: 0,
            fix2: 0,
            skip_localHashMismatch: 0,
            skip_requestHashMismatch: 0,
            returned: 0,
            missingResp: false,
            noResp: false,
          }

          const hashMap = new Map()
          const accountIDs = []

          //should limit on asking side, this is just a precaution
          if (payload.accounts.length > 900) {
            payload.accounts = payload.accounts.slice(0, 900)
          }

          for (const accountHashEntry of payload.accounts) {
            // let radix = accountHashEntry.accountID.substr(0, this.treeMaxDepth)
            // let layerMap = this.shardTrie.layerMaps[this.treeMaxDepth]
            // let hashTrieNode = layerMap.get(radix)
            if (
              accountHashEntry == null ||
              accountHashEntry.hash == null ||
              accountHashEntry.accountID == null
            ) {
              queryStats.fix1++
              continue
            }
            hashMap.set(accountHashEntry.accountID, accountHashEntry.hash)
            accountIDs.push(accountHashEntry.accountID)
          }

          const accountData = await this.app.getAccountDataByList(accountIDs)

          const skippedAccounts: AccountIDAndHash[] = []
          const returnedAccounts: AccountIDAndHash[] = []

          const accountsToGetStateTableDataFor = []
          //only return results that match the requested hash!
          const accountDataFinal: Shardus.WrappedData[] = []
          if (accountData != null) {
            for (const wrappedAccount of accountData) {
              if (wrappedAccount == null || wrappedAccount.stateId == null || wrappedAccount.data == null) {
                queryStats.fix2++
                continue
              }

              const { accountId, stateId, data: recordData } = wrappedAccount
              const accountHash = this.app.calculateAccountHash(recordData)
              if (stateId !== accountHash) {
                skippedAccounts.push({ accountID: accountId, hash: stateId })
                queryStats.skip_localHashMismatch++
                continue
              }

              if (hashMap.get(accountId) === wrappedAccount.stateId) {
                accountDataFinal.push(wrappedAccount)
                returnedAccounts.push({ accountID: accountId, hash: stateId })
                accountsToGetStateTableDataFor.push(accountId)
                queryStats.returned++
              } else {
                queryStats.skip_requestHashMismatch++
                skippedAccounts.push({ accountID: accountId, hash: stateId })
              }

              // let wrappedAccountInQueueRef = wrappedAccount as Shardus.WrappedDataFromQueue
              // wrappedAccountInQueueRef.seenInQueue = false

              // if (this.stateManager.lastSeenAccountsMap != null) {
              //   let queueEntry = this.stateManager.lastSeenAccountsMap[wrappedAccountInQueueRef.accountId]
              //   if (queueEntry != null) {
              //     wrappedAccountInQueueRef.seenInQueue = true
              //   }
              // }
            }
          }
          //PERF could disable this for more perf?
          //this.stateManager.testAccountDataWrapped(accountDataFinal)

          if (queryStats.returned < payload.accounts.length) {
            nestedCountersInstance.countEvent('accountPatcher', `get_account_data_by_hashes incomplete`)
            queryStats.missingResp = true
            if (queryStats.returned === 0) {
              nestedCountersInstance.countEvent('accountPatcher', `get_account_data_by_hashes no results`)
              queryStats.noResp = true
            }
          }

          this.mainLogger.debug(
            `get_account_data_by_hashes1 requests[${payload.accounts.length}] :${utils.stringifyReduce(
              payload.accounts
            )} `
          )
          this.mainLogger.debug(
            `get_account_data_by_hashes2 skippedAccounts:${utils.stringifyReduce(skippedAccounts)} `
          )
          this.mainLogger.debug(
            `get_account_data_by_hashes3 returnedAccounts:${utils.stringifyReduce(returnedAccounts)} `
          )
          this.mainLogger.debug(
            `get_account_data_by_hashes4 queryStats:${utils.stringifyReduce(queryStats)} `
          )
          this.mainLogger.debug(
            `get_account_data_by_hashes4 stateTabledata:${utils.stringifyReduce(result.stateTableData)} `
          )
          result.accounts = accountDataFinal
        } catch (ex) {
          this.statemanager_fatal(
            `get_account_data_by_hashes-failed`,
            'get_account_data_by_hashes:' + ex.name + ': ' + ex.message + ' at ' + ex.stack
          )
        }
        const respondSize = await respond(result)
        profilerInstance.scopedProfileSectionEnd('get_account_data_by_hashes', respondSize)
      }
    )

    Context.network.registerExternalGet(
      'debug-patcher-ignore-hash-updates',
      isDebugModeMiddleware,
      (_req, res) => {
        try {
          this.debug_ignoreUpdates = !this.debug_ignoreUpdates
          res.write(`this.debug_ignoreUpdates: ${this.debug_ignoreUpdates}\n`)
        } catch (e) {
          res.write(`${e}\n`)
        }
        res.end()
      }
    )
    Context.network.registerExternalGet('debug-patcher-fail-tx', isDebugModeMiddleware, (_req, res) => {
      try {
        //toggle chance to fail TXs in a way that they do not get fixed by the first tier of repair.

        if (this.stateManager.failNoRepairTxChance === 0) {
          this.stateManager.failNoRepairTxChance = 1
        } else {
          this.stateManager.failNoRepairTxChance = 0
        }

        res.write(`this.failNoRepairTxChance: ${this.stateManager.failNoRepairTxChance}\n`)
      } catch (e) {
        res.write(`${e}\n`)
      }
      res.end()
    })
    Context.network.registerExternalGet('debug-patcher-voteflip', isDebugModeMiddleware, (_req, res) => {
      try {
        if (this.stateManager.voteFlipChance === 0) {
          this.stateManager.voteFlipChance = 1
        } else {
          this.stateManager.voteFlipChance = 0
        }

        res.write(`this.voteFlipChance: ${this.stateManager.voteFlipChance}\n`)
      } catch (e) {
        res.write(`${e}\n`)
      }
      res.end()
    })
    Context.network.registerExternalGet('debug-patcher-toggle-skip', isDebugModeMiddleware, (_req, res) => {
      try {
        if (this.stateManager.debugSkipPatcherRepair === false) {
          this.stateManager.debugSkipPatcherRepair = true
        } else {
          this.stateManager.debugSkipPatcherRepair = false
        }

        res.write(`this.debugSkipPatcherRepair: ${this.stateManager.debugSkipPatcherRepair}\n`)
      } catch (e) {
        res.write(`${e}\n`)
      }
      res.end()
    })
    Context.network.registerExternalGet('debug-patcher-dumpTree', isDebugModeMiddleware, (_req, res) => {
      try {
        // this.statemanager_fatal('debug shardTrie',`temp shardTrie ${utils.stringifyReduce(this.shardTrie.layerMaps[0].values().next().value)}`)
        // res.write(`${utils.stringifyReduce(this.shardTrie.layerMaps[0].values().next().value)}\n`)

        const trieRoot = this.shardTrie.layerMaps[0].values().next().value

        //strip noisy fields
        const tempString = JSON.stringify(trieRoot, utils.debugReplacer)
        const processedObject = JSON.parse(tempString)

        // use stringify to put a stable sort on the object keys (important for comparisons)
        const finalStr = utils.stringifyReduce(processedObject)

        this.statemanager_fatal('debug shardTrie', `temp shardTrie ${finalStr}`)
        res.write(`${finalStr}\n`)
      } catch (e) {
        res.write(`${e}\n`)
      }
      res.end()
    })

    Context.network.registerExternalGet(
      'debug-patcher-dumpTree-partial',
      isDebugModeMiddleware,
      (req, res) => {
        try {
          const subTree: boolean = req.query.subtree === 'true' ? true : false
          let radix: string = req.query.radix as string
          if (radix.length > this.treeMaxDepth) radix = radix.slice(0, this.treeMaxDepth)
          const level = radix.length
          const layerMap = this.shardTrie.layerMaps[level] // eslint-disable-line security/detect-object-injection

          let hashTrieNode = layerMap.get(radix.toLowerCase())
          if (!subTree) {
            // deep clone the trie node before removing children property
            hashTrieNode = JSON.parse(JSON.stringify(hashTrieNode))
            delete hashTrieNode.children
          }
          //strip noisy fields
          const tempString = JSON.stringify(hashTrieNode, utils.debugReplacer)
          const processedObject = JSON.parse(tempString)

          // use stringify to put a stable sort on the object keys (important for comparisons)
          const finalStr = utils.stringifyReduce(processedObject)

          this.statemanager_fatal('debug shardTrie', `temp shardTrie ${finalStr}`)
          res.write(`${finalStr}\n`)
        } catch (e) {
          console.log('Error', e)
          res.write(`${e}\n`)
        }
        res.end()
      }
    )

    Context.network.registerExternalGet('debug-patcher-fail-hashes', isDebugModeMiddleware, (_req, res) => {
      try {
        const lastCycle = this.p2p.state.getLastCycle()
        const cycle = lastCycle.counter
        const minVotes = this.calculateMinVotes()
        const notEnoughVotesRadix = {}
        const outOfSyncRadix = {}

        const hashTrieSyncConsensus = this.hashTrieSyncConsensusByCycle.get(cycle)

        if (!hashTrieSyncConsensus) {
          return res.json({ error: `Unable to find hashTrieSyncConsensus for last cycle ${lastCycle}` })
        }

        for (const radix of hashTrieSyncConsensus.radixHashVotes.keys()) {
          const votesMap = hashTrieSyncConsensus.radixHashVotes.get(radix)
          const ourTrieNode = this.shardTrie.layerMaps[this.treeSyncDepth].get(radix)

          const hasEnoughVotes = votesMap.bestVotes >= minVotes
          const isRadixInSync = ourTrieNode ? ourTrieNode.hash === votesMap.bestHash : false

          if (!hasEnoughVotes || !isRadixInSync) {
            const kvp = []
            for (const [key, value] of votesMap.allVotes.entries()) {
              kvp.push({
                id: key,
                count: value.count,
                nodeIDs: value.voters.map((node) => utils.makeShortHash(node.id) + ':' + node.externalPort),
              })
            }
            const simpleMap = {
              bestHash: votesMap.bestHash,
              ourHash: ourTrieNode ? ourTrieNode.hash : '',
              bestVotes: votesMap.bestVotes,
              minVotes,
              allVotes: kvp,
            }
            if (!hasEnoughVotes) notEnoughVotesRadix[radix] = simpleMap // eslint-disable-line security/detect-object-injection
            if (!isRadixInSync) outOfSyncRadix[radix] = simpleMap // eslint-disable-line security/detect-object-injection
          }
        }
        return res.json({
          cycle,
          notEnoughVotesRadix,
          outOfSyncRadix,
        })
      } catch (e) {
        console.log('Error', e)
        res.write(`${e}\n`)
      }
      res.end()
    })

    Context.network.registerExternalGet('get-tree-last-insync', isDebugModeMiddleware, (_req, res) => {
      res.write(`${this.failedLastTrieSync === false}\n`)

      res.end()
    })

    //TODO DEBUG DO NOT USE IN LIVE NETWORK
    Context.network.registerExternalGet(
      'get-tree-last-insync-all',
      isDebugModeMiddleware,
      async (req, res) => {
        const format = req.query.format ?? 'text'
        const resData = {
          nodes: [],
          totalOOS: 0,
          inSync: false,
        }
        try {
          //wow, why does Context.p2p not work..
          let oosCount = 0
          const activeNodes = Wrapper.p2p.state.getNodes()
          if (activeNodes) {
            for (const node of activeNodes.values()) {
              const getResp = await this.logger._internalHackGetWithResp(
                `${node.externalIp}:${node.externalPort}/get-tree-last-insync`
              )
              if (getResp.body && getResp.body.includes('false')) {
                oosCount++
              }
              resData.nodes.push({
                node: `${node.externalIp}:${node.externalPort}`,
                data: `${getResp.body ? getResp.body.trim() : 'no data'}`,
              })
            }
          }

          resData.totalOOS = oosCount
          resData.inSync = this.failedLastTrieSync === false

          if (format === 'text') {
            for (const node of resData.nodes) {
              res.write(`inSync: ${node.data}  ${node.node}\n`)
            }
            res.write(`this node in sync:${this.failedLastTrieSync === false} totalOOS:${oosCount} \n`)
          } else {
            res.status(200).jsonp(resData)
          }
        } catch (e) {
          res.status(500).jsonp(e)
        }

        res.end()
      }
    )

    Context.network.registerExternalGet('trie-repair-dump', isDebugModeMiddleware, (_req, res) => {
      res.write(`${utils.stringifyReduce(this.lastRepairInfo)}\n`)
      res.end()
    })

    //
    Context.network.registerExternalGet('get-shard-dump', isDebugModeMiddleware, (_req, res) => {
      res.write(`${this.stateManager.lastShardReport}\n`)
      res.end()
    })

    //TODO DEBUG DO NOT USE IN LIVE NETWORK
    Context.network.registerExternalGet('get-shard-dump-all', isDebugModeMiddleware, async (_req, res) => {
      try {
        //wow, why does Context.p2p not work..
        res.write(`last shard reports \n`)
        const activeNodes = Wrapper.p2p.state.getNodes()
        if (activeNodes) {
          for (const node of activeNodes.values()) {
            const getResp = await this.logger._internalHackGetWithResp(
              `${node.externalIp}:${node.externalPort}/get-shard-dump`
            )
            res.write(`${node.externalIp}:${node.externalPort}; `)
            res.write(getResp.body ? getResp.body : '')
            res.write('\n')
          }
        }
        //res.write(`this node in sync:${this.failedLastTrieSync} \n`)
      } catch (e) {
        res.write(`${e}\n`)
      }
      res.end()
    })

    Context.network.registerExternalGet('get-shard-report-all', isDebugModeMiddleware, async (_req, res) => {
      try {
        //wow, why does Context.p2p not work..
        res.write(`building shard report \n`)
        const activeNodes = Wrapper.p2p.state.getNodes()
        const lines = []
        if (activeNodes) {
          for (const node of activeNodes.values()) {
            const getResp = await this.logger._internalHackGetWithResp(
              `${node.externalIp}:${node.externalPort}/get-shard-dump`
            )
            if (getResp.body != null && getResp.body != '') {
              lines.push({ raw: getResp.body, file: { owner: `${node.externalIp}:${node.externalPort}` } })
            }
          }
          this.processShardDump(res, lines)
        }
        //res.write(`this node in sync:${this.failedLastTrieSync} \n`)
      } catch (e) {
        res.write(`${e}\n`)
      }
      res.end()
    })

    /**
     *
     *
     * Usage: http://<NODE_IP>:<NODE_EXT_PORT>/account-report?id=<accountID>
     */
    Context.network.registerExternalGet('account-report', isDebugModeMiddleware, async (req, res) => {
      if (req.query.id == null) return
      let id = req.query.id as string
      res.write(`report for: ${id} \n`)
      try {
        if (id.length === 10) {
          //short form..
          let found = false
          const prefix = id.substring(0, 4)
          const low = prefix + '0'.repeat(60)
          const high = prefix + 'f'.repeat(60)

          const suffix = id.substring(5, 10)
          const possibleAccounts = await this.app.getAccountDataByRange(
            low,
            high,
            0,
            shardusGetTime(),
            100,
            0,
            ''
          )

          res.write(`searching ${possibleAccounts.length} accounts \n`)

          for (const account of possibleAccounts) {
            if (account.accountId.endsWith(suffix)) {
              res.write(`found full account ${id} => ${account.accountId} \n`)
              id = account.accountId
              found = true

              break
            }
          }

          if (found == false) {
            res.write(`could not find account\n`)
            res.end()
            return
          }
        }

        const trieAccount = this.getAccountTreeInfo(id)
        const accountHash = this.stateManager.accountCache.getAccountHash(id)
        const accountHashFull = this.stateManager.accountCache.getAccountDebugObject(id) //this.stateManager.accountCache.accountsHashCache3.accountHashMap.get(id)
        const accountData = await this.app.getAccountDataByList([id])

        res.write(`trieAccount: ${JSON.stringify(trieAccount)} \n`)
        res.write(`accountHash: ${JSON.stringify(accountHash)} \n`)
        res.write(`accountHashFull: ${JSON.stringify(accountHashFull)} \n`)
        res.write(`accountData: ${JSON.stringify(accountData)} \n\n`)
        res.write(`tests: \n`)
        if (accountData != null && accountData.length === 1 && accountHash != null) {
          res.write(`accountData hash matches cache ${accountData[0].stateId === accountHash.h} \n`)
        }
        if (accountData != null && accountData.length === 1 && trieAccount != null) {
          res.write(`accountData matches trieAccount ${accountData[0].stateId === trieAccount.hash} \n`)
        }
      } catch (e) {
        res.write(`${e}\n`)
      }
      res.end()
    })

    /**
     *
     *
     * Usage: http://<NODE_IP>:<NODE_EXT_PORT>/account-coverage?id=<accountID>
     */
    Context.network.registerExternalGet('account-coverage', isDebugModeMiddleware, async (req, res) => {
      if (req.query.id === null) return
      const id = req.query.id as string

      const possibleAccountsIds: string[] = []
      try {
        if (id.length === 10) {
          //short form..
          const prefix = id.substring(0, 4)
          const low = prefix + '0'.repeat(60)
          const high = prefix + 'f'.repeat(60)

          const suffix = id.substring(5, 10)
          const possibleAccounts = await this.app.getAccountDataByRange(
            low,
            high,
            0,
            shardusGetTime(),
            100,
            0,
            ''
          )

          for (const account of possibleAccounts) {
            if (account.accountId.endsWith(suffix)) {
              possibleAccountsIds.push(account.accountId)
            }
          }
        } else {
          possibleAccountsIds.push(id)
        }

        if (possibleAccountsIds.length === 0) {
          res.write(
            JSON.stringify({
              success: false,
              error: 'could not find account',
            })
          )
        } else {
          const resObj = {}
          for (const accountId of possibleAccountsIds) {
            const consensusNodes = this.stateManager.transactionQueue.getConsenusGroupForAccount(accountId)
            const storedNodes = this.stateManager.transactionQueue.getStorageGroupForAccount(accountId)

            // eslint-disable-next-line security/detect-object-injection
            resObj[accountId] = {
              consensusNodes: consensusNodes.map((node) => {
                return {
                  id: node.id,
                  externalIp: node.externalIp,
                  externalPort: node.externalPort,
                  internalIp: node.internalIp,
                  internalPort: node.internalPort,
                }
              }),
              storedNodes: storedNodes.map((node) => {
                return {
                  id: node.id,
                  externalIp: node.externalIp,
                  externalPort: node.externalPort,
                  internalIp: node.internalIp,
                  internalPort: node.internalPort,
                }
              }),
            }
          }
          res.write(
            JSON.stringify({
              success: true,
              result: resObj,
            })
          )
        }
      } catch (e) {
        res.write(
          JSON.stringify({
            success: false,
            error: e,
          })
        )
      }
      res.end()
    })

    Context.network.registerExternalGet('hack-version', isDebugModeMiddleware, (_req, res) => {
      res.write(`1.0.1\n`)
      res.end()
    })
  }

  getAccountTreeInfo(accountID: string): TrieAccount {
    const radix = accountID.substring(0, this.treeMaxDepth)

    const treeNode = this.shardTrie.layerMaps[this.treeMaxDepth].get(radix)
    if (treeNode == null || treeNode.accountTempMap == null) {
      return null
    }
    return treeNode.accountTempMap.get(accountID)
  }

  /***
   *    ##     ## ########     ###    ######## ########  ######  ##     ##    ###    ########  ########  ######## ########  #### ########
   *    ##     ## ##     ##   ## ##      ##    ##       ##    ## ##     ##   ## ##   ##     ## ##     ##    ##    ##     ##  ##  ##
   *    ##     ## ##     ##  ##   ##     ##    ##       ##       ##     ##  ##   ##  ##     ## ##     ##    ##    ##     ##  ##  ##
   *    ##     ## ########  ##     ##    ##    ######    ######  ######### ##     ## ########  ##     ##    ##    ########   ##  ######
   *    ##     ## ##        #########    ##    ##             ## ##     ## ######### ##   ##   ##     ##    ##    ##   ##    ##  ##
   *    ##     ## ##        ##     ##    ##    ##       ##    ## ##     ## ##     ## ##    ##  ##     ##    ##    ##    ##   ##  ##
   *     #######  ##        ##     ##    ##    ########  ######  ##     ## ##     ## ##     ## ########     ##    ##     ## #### ########
   */

  upateShardTrie(cycle: number): HashTrieUpdateStats {
    //we start with the later of nodes at max depth, and will build upwards one layer at a time
    const currentLayer = this.treeMaxDepth
    let treeNodeQueue: HashTrieNode[] = []

    const updateStats = {
      leafsUpdated: 0,
      leafsCreated: 0,
      updatedNodesPerLevel: new Array(this.treeMaxDepth + 1).fill(0),
      hashedChildrenPerLevel: new Array(this.treeMaxDepth + 1).fill(0),
      totalHashes: 0,
      //totalObjectsHashed: 0,
      totalNodesHashed: 0,
      totalAccountsHashed: 0,
      totalLeafs: 0,
    }

    //feed account data into lowest layer, generates list of treeNodes
    let currentMap = this.shardTrie.layerMaps[currentLayer] // eslint-disable-line security/detect-object-injection
    if (currentMap == null) {
      currentMap = new Map()
      this.shardTrie.layerMaps[currentLayer] = currentMap // eslint-disable-line security/detect-object-injection
    }

    //process accounts that need updating.  Create nodes as needed
    for (let i = 0; i < this.accountUpdateQueue.length; i++) {
      const tx = this.accountUpdateQueue[i] // eslint-disable-line security/detect-object-injection
      const key = tx.accountID.slice(0, currentLayer)
      let leafNode = currentMap.get(key)
      if (leafNode == null) {
        //init a leaf node.
        //leaf nodes will have a list of accounts that share the same radix.
        leafNode = {
          radix: key,
          children: [],
          childHashes: [],
          accounts: [],
          hash: '',
          accountTempMap: new Map(),
          updated: true,
          isIncomplete: false,
          nonSparseChildCount: 0,
        } //this map will cause issues with update
        currentMap.set(key, leafNode)
        updateStats.leafsCreated++
        treeNodeQueue.push(leafNode)
      }

      //this can happen if the depth gets smaller after being larger
      if (leafNode.accountTempMap == null) {
        leafNode.accountTempMap = new Map()
      }
      if (leafNode.accounts == null) {
        leafNode.accounts = []
      }

      if (leafNode.accountTempMap.has(tx.accountID) === false) {
        this.totalAccounts++
      }
      leafNode.accountTempMap.set(tx.accountID, tx)
      if (leafNode.updated === false) {
        treeNodeQueue.push(leafNode)
        updateStats.leafsUpdated++
      }
      leafNode.updated = true

      //too frequent in large tests.  only use this in local tests with smaller data
      //if (logFlags.verbose) /* prettier-ignore */ if (logFlags.playback) this.logger.playbackLogNote('accountPatcher', `upateShardTrie ${utils.makeShortHash(tx.accountID)}`, `upateShardTrie update: ${utils.makeShortHash(tx.accountID)} h:${utils.makeShortHash(tx.hash)}`)
    }

    let removedAccounts = 0
    let removedAccountsFailed = 0

    if (this.accountRemovalQueue.length > 0) {
      //this.statemanager_fatal(`temp accountRemovalQueue`,`accountRemovalQueue c:${cycle} ${utils.stringifyReduce(this.accountRemovalQueue)}`)
      /* prettier-ignore */ if (logFlags.verbose) this.mainLogger.debug(`remove account from trie tracking c:${cycle} ${utils.stringifyReduce(this.accountRemovalQueue)}`)
    }

    //remove accoutns from the trie.  this happens if our node no longer carries them in storage range.
    for (let i = 0; i < this.accountRemovalQueue.length; i++) {
      const accountID = this.accountRemovalQueue[i] // eslint-disable-line security/detect-object-injection

      const key = accountID.slice(0, currentLayer)
      const treeNode = currentMap.get(key)
      if (treeNode == null) {
        continue //already gone!
      }

      if (treeNode.updated === false) {
        treeNodeQueue.push(treeNode)
      }
      treeNode.updated = true

      if (treeNode.accountTempMap == null) {
        treeNode.accountTempMap = new Map()
      }
      if (treeNode.accounts == null) {
        treeNode.accounts = []
      }
      const removed = treeNode.accountTempMap.delete(accountID)
      if (removed) {
        removedAccounts++
        /* prettier-ignore */ if (logFlags.verbose) if (logFlags.playback) this.logger.playbackLogNote('accountPatcher', `upateShardTrie ${utils.makeShortHash(accountID)}`, `upateShardTrie remove ${utils.makeShortHash(accountID)} `)
      } else {
        removedAccountsFailed++
      }
    }
    if (removedAccounts > 0) {
      nestedCountersInstance.countEvent(`accountPatcher`, `removedAccounts c:${cycle}`, removedAccounts)
    }
    if (removedAccountsFailed > 0) {
      /* prettier-ignore */ nestedCountersInstance.countEvent(`accountPatcher`, `removedAccountsFailed c:${cycle}`, removedAccountsFailed)
    }
    this.accountRemovalQueue = []

    // for(let treeNode of this.incompleteNodes){
    //   treeNodeQueue.push(treeNode)
    // }

    //look at updated leaf nodes.  Sort accounts and update hash values
    for (let i = 0; i < treeNodeQueue.length; i++) {
      const treeNode = treeNodeQueue[i] // eslint-disable-line security/detect-object-injection

      if (treeNode.updated === true) {
        //treeNode.accountTempMap != null){
        treeNode.accounts = Array.from(treeNode.accountTempMap.values())

        //delete treeNode.accountTempMap...  need to keep it
        //treeNode.accountTempMap = null

        //sort treeNode.accounts by accountID
        treeNode.accounts.sort(this.sortByAccountID)
        //compute treenode hash of accounts
        treeNode.hash = this.hashObj(treeNode.accounts.map((a) => a.hash)) //todo why is this needed!!!

        treeNode.updated = false

        updateStats.totalHashes++
        updateStats.totalAccountsHashed = updateStats.totalAccountsHashed + treeNode.accounts.length
        updateStats.updatedNodesPerLevel[currentLayer] = updateStats.updatedNodesPerLevel[currentLayer] + 1 // eslint-disable-line security/detect-object-injection
      }
    }

    // update the tree one later at a time. start at the max depth and copy values to the parents.
    // Then the parent depth becomes the working depth and we repeat the process
    // a queue is used to efficiently update only the nodes that need it.
    // hashes are efficiently calculated only once after all children have set their hash data in the childHashes
    let parentTreeNodeQueue = []
    //treenode queue has updated treeNodes from each loop, gets fed into next loop
    for (let i = currentLayer - 1; i >= 0; i--) {
      currentMap = this.shardTrie.layerMaps[i] // eslint-disable-line security/detect-object-injection
      if (currentMap == null) {
        currentMap = new Map()
        this.shardTrie.layerMaps[i] = currentMap // eslint-disable-line security/detect-object-injection
      }
      //loop each node in treeNodeQueue (nodes from the previous level down)
      for (let j = 0; j < treeNodeQueue.length; j++) {
        const treeNode = treeNodeQueue[j] // eslint-disable-line security/detect-object-injection

        //compute parent nodes.
        const parentKey = treeNode.radix.slice(0, i)
        // fast? 0-15 conversion
        let index = treeNode.radix.charCodeAt(i)
        index = index < 90 ? index - 48 : index - 87
        //get parent node
        let parentTreeNode = currentMap.get(parentKey)
        if (parentTreeNode == null) {
          parentTreeNode = {
            radix: parentKey,
            children: new Array(16),
            childHashes: new Array(16),
            updated: false,
            hash: '',
            isIncomplete: false,
            nonSparseChildCount: 0,
          }
          currentMap.set(parentKey, parentTreeNode)
        }

        //if we have not set this child yet then count it
        // eslint-disable-next-line security/detect-object-injection
        if (parentTreeNode.children[index] == null) {
          // eslint-disable-line security/detect-object-injection
          parentTreeNode.nonSparseChildCount++
        }

        //assign position
        parentTreeNode.children[index] = treeNode // eslint-disable-line security/detect-object-injection
        parentTreeNode.childHashes[index] = treeNode.hash // eslint-disable-line security/detect-object-injection

        //insert new parent nodes if we have not yet, guided by updated flag
        if (parentTreeNode.updated === false) {
          parentTreeNodeQueue.push(parentTreeNode)
          parentTreeNode.updated = true
        }

        if (treeNode.isIncomplete) {
          // if(parentTreeNode.isIncomplete === false && parentTreeNode.updated === false ){
          //   parentTreeNode.updated = true
          //   parentTreeNodeQueue.push(parentTreeNode)
          // }
          parentTreeNode.isIncomplete = true
        }

        treeNode.updated = false //finished update of this node.
      }

      updateStats.updatedNodesPerLevel[i] = parentTreeNodeQueue.length // eslint-disable-line security/detect-object-injection

      //when we are one step below the sync depth add in incompete parents for hash updates!
      // if(i === this.treeSyncDepth + 1){
      //   for(let treeNode of this.incompleteNodes){
      //     parentTreeNodeQueue.push(treeNode)
      //   }
      // }

      //loop and compute hashes of parents
      for (let j = 0; j < parentTreeNodeQueue.length; j++) {
        const parentTreeNode = parentTreeNodeQueue[j] // eslint-disable-line security/detect-object-injection
        parentTreeNode.hash = this.hashObj(parentTreeNode.childHashes)

        updateStats.totalHashes++
        updateStats.totalNodesHashed = updateStats.totalNodesHashed + parentTreeNode.nonSparseChildCount
        updateStats.hashedChildrenPerLevel[i] = // eslint-disable-line security/detect-object-injection
          updateStats.hashedChildrenPerLevel[i] + parentTreeNode.nonSparseChildCount // eslint-disable-line security/detect-object-injection
      }
      //set the parents to the treeNodeQueue so we can loop and work on the next layer up
      treeNodeQueue = parentTreeNodeQueue
      parentTreeNodeQueue = []
    }

    updateStats.totalLeafs = this.shardTrie.layerMaps[this.treeMaxDepth].size

    this.accountUpdateQueue = []

    return updateStats
  }

  getNonConsensusRanges(cycle: number): { low: string; high: string }[] {
    let incompleteRanges = []

    //get the min and max non covered area
    const shardValues = this.stateManager.shardValuesByCycle.get(cycle)

    const consensusStartPartition = shardValues.nodeShardData.consensusStartPartition
    const consensusEndPartition = shardValues.nodeShardData.consensusEndPartition

    incompleteRanges = this.getNonParitionRanges(
      shardValues,
      consensusStartPartition,
      consensusEndPartition,
      this.treeSyncDepth
    )

    return incompleteRanges
  }

  getNonStoredRanges(cycle: number): { low: string; high: string }[] {
    let incompleteRanges = []

    //get the min and max non covered area
    const shardValues = this.stateManager.shardValuesByCycle.get(cycle)
    if (shardValues) {
      const consensusStartPartition = shardValues.nodeShardData.storedPartitions.partitionStart
      const consensusEndPartition = shardValues.nodeShardData.storedPartitions.partitionEnd

      incompleteRanges = this.getNonParitionRanges(
        shardValues,
        consensusStartPartition,
        consensusEndPartition,
        this.treeSyncDepth
      )
    }

    return incompleteRanges
  }

  getSyncTrackerRanges(): { low: string; high: string }[] {
    const incompleteRanges = []

    for (const syncTracker of this.stateManager.accountSync.syncTrackers) {
      if (syncTracker.syncFinished === false && syncTracker.isGlobalSyncTracker === false) {
        incompleteRanges.push({
          low: syncTracker.range.low.substring(0, this.treeSyncDepth),
          high: syncTracker.range.high.substring(0, this.treeSyncDepth),
        })
      }
    }
    return incompleteRanges
  }

  /**
   * Uses a wrappable start and end partition range as input and figures out the array
   *  of ranges that would not be covered by these partitions.
   *
   * TODO!  consider if the offset used in "partition space" should really be happening on the result address instead!
   *        I think that would be more correct.  getConsensusSnapshotPartitions would need adjustments after this since it
   *        is making this compensation on its own.
   *
   * @param shardValues
   * @param startPartition
   * @param endPartition
   * @param depth How many characters long should the high/low return values be? usually treeSyncDepth
   */
  getNonParitionRanges(
    shardValues: CycleShardData,
    startPartition: number,
    endPartition: number,
    depth: number
  ): { low: string; high: string }[] {
    const incompleteRanges = []

    const shardGlobals = shardValues.shardGlobals as StateManagerTypes.shardFunctionTypes.ShardGlobals
    const numPartitions = shardGlobals.numPartitions

    if (startPartition === 0 && endPartition === numPartitions - 1) {
      //nothing to mark incomplete our node covers the whole range with its consensus
      return incompleteRanges
    }

    //let incompeteAddresses = []
    if (startPartition > endPartition) {
      //consensus range like this  <CCCC---------CCC>
      //incompletePartition:            1       2

      //we may have two ranges to mark
      const incompletePartition1 = endPartition + 1 // get the start of this
      const incompletePartition2 = startPartition - 1 //get the end of this

      const partition1 = shardValues.parititionShardDataMap.get(incompletePartition1)
      const partition2 = shardValues.parititionShardDataMap.get(incompletePartition2)

      const incompleteRange = {
        low: partition1.homeRange.low.substring(0, depth),
        high: partition2.homeRange.high.substring(0, depth),
      }
      incompleteRanges.push(incompleteRange)
      return incompleteRanges
    } else if (endPartition > startPartition) {
      //consensus range like this  <-----CCCCC------> or <-----------CCCCC> or <CCCCC----------->
      //incompletePartition:            1     2           2         1                2         1
      //   not needed:                                    x                                    x

      //we may have two ranges to mark
      let incompletePartition1 = startPartition - 1 //get the end of this
      let incompletePartition2 = endPartition + 1 // get the start of this

      //<CCCCC----------->
      //      2         1
      if (startPartition === 0) {
        // = numPartitions - 1 //special case, we stil want the start
        incompletePartition1 = numPartitions - 1

        const partition1 = shardValues.parititionShardDataMap.get(incompletePartition2)
        const partition2 = shardValues.parititionShardDataMap.get(incompletePartition1)

        const incompleteRange = {
          low: partition1.homeRange.low.substring(0, depth),
          high: partition2.homeRange.high.substring(0, depth),
        }
        incompleteRanges.push(incompleteRange)
        return incompleteRanges
      }
      //<-----------CCCCC>
      // 2         1
      if (endPartition === numPartitions - 1) {
        //incompletePartition2 = 0 //special case, we stil want the start
        incompletePartition2 = 0

        const partition1 = shardValues.parititionShardDataMap.get(incompletePartition2)
        const partition2 = shardValues.parititionShardDataMap.get(incompletePartition1)

        const incompleteRange = {
          low: partition1.homeRange.low.substring(0, depth),
          high: partition2.homeRange.high.substring(0, depth),
        }
        incompleteRanges.push(incompleteRange)
        return incompleteRanges
      }

      //<-----CCCCC------>
      // 0   1     2    n-1
      const partition1 = shardValues.parititionShardDataMap.get(0)
      const partition2 = shardValues.parititionShardDataMap.get(incompletePartition1)
      const incompleteRange = {
        low: partition1.homeRange.low.substring(0, depth),
        high: partition2.homeRange.high.substring(0, depth),
      }

      const partition1b = shardValues.parititionShardDataMap.get(incompletePartition2)
      const partition2b = shardValues.parititionShardDataMap.get(numPartitions - 1)
      const incompleteRangeB = {
        low: partition1b.homeRange.low.substring(0, depth),
        high: partition2b.homeRange.high.substring(0, depth),
      }

      incompleteRanges.push(incompleteRange)
      incompleteRanges.push(incompleteRangeB)
      return incompleteRanges
    }
  }

  initStoredRadixValues(cycle: number): void {
    // //mark these here , call this where we first create the vote structure for the cycle (could be two locations)
    // nonStoredRanges: {low:string,high:string}[]
    // radixIsStored: Map<string, boolean>

    this.nonStoredRanges = this.getNonStoredRanges(cycle)
    this.radixIsStored.clear()
  }

  isRadixStored(_cycle: number, radix: string): boolean {
    if (this.radixIsStored.has(radix)) {
      return this.radixIsStored.get(radix)
    }

    let isNotStored = false
    for (const range of this.nonStoredRanges) {
      if (radix >= range.low && radix <= range.high) {
        isNotStored = true
        continue
      }
    }
    const isStored = !isNotStored
    this.radixIsStored.set(radix, isStored)
    return isStored
  }

  /***
   *    ########  #### ######## ########  ######   #######  ##    ##  ######  ######## ##    ## ##     ##  ######
   *    ##     ##  ##  ##       ##       ##    ## ##     ## ###   ## ##    ## ##       ###   ## ##     ## ##    ##
   *    ##     ##  ##  ##       ##       ##       ##     ## ####  ## ##       ##       ####  ## ##     ## ##
   *    ##     ##  ##  ######   ######   ##       ##     ## ## ## ##  ######  ######   ## ## ## ##     ##  ######
   *    ##     ##  ##  ##       ##       ##       ##     ## ##  ####       ## ##       ##  #### ##     ##       ##
   *    ##     ##  ##  ##       ##       ##    ## ##     ## ##   ### ##    ## ##       ##   ### ##     ## ##    ##
   *    ########  #### ##       ##        ######   #######  ##    ##  ######  ######## ##    ##  #######   ######
   */

  /**
   * diffConsenus
   * get a list where mapB does not have entries that match consensusArray.
   * Note this only works one way.  we do not find cases where mapB has an entry that consensusArray does not.
   *  //   (TODO, compute this and at least start logging it.(if in debug mode))
   * @param consensusArray the list of radix and hash values that have been voted on by the majority
   * @param mapB a map of our hashTrie nodes to compare to the consensus
   */
  diffConsenus(
    consensusArray: RadixAndHash[],
    mapB: Map<string, HashTrieNode>
  ): { radix: string; hash: string }[] {
    if (consensusArray == null) {
      this.statemanager_fatal('diffConsenus: consensusArray == null', 'diffConsenus: consensusArray == null')
      return []
    }

    //map
    const toFix = []
    for (const value of consensusArray) {
      if (mapB == null) {
        toFix.push(value)
        continue
      }

      const valueB = mapB.get(value.radix)
      if (valueB == null) {
        //missing
        toFix.push(value)
        continue
      }
      if (valueB.hash !== value.hash) {
        //different hash
        toFix.push(value)
      }
    }
    return toFix
  }

  /**
   * findExtraChildren
   * a debug method to figure out if we have keys not covered by other nodes.
   * @param consensusArray
   * @param mapB
   * @returns
   */
  findExtraBadKeys(consensusArray: RadixAndHash[], mapB: Map<string, HashTrieNode>): string[] {
    const extraBadKeys = []
    if (consensusArray == null) {
      this.statemanager_fatal(
        'findExtraBadKeys: consensusArray == null',
        'findExtraBadKeys: consensusArray == null'
      )
      return []
    }
    const parentKeys = new Set()
    const goodKeys = new Set()
    //build sets of parents and good keys
    for (const value of consensusArray) {
      const parentKey = value.radix.slice(0, value.radix.length - 1)
      parentKeys.add(parentKey)
      goodKeys.add(value.radix)
    }

    //iterate all possible children of the parent keys and detect if we have extra keys that are not in the good list
    for (const parentKey of parentKeys) {
      for (let i = 0; i < 16; i++) {
        const childKey = parentKey + i.toString(16)
        const weHaveKey = mapB.has(childKey)
        if (weHaveKey) {
          const theyHaveKey = goodKeys.has(childKey)
          if (theyHaveKey === false) {
            extraBadKeys.push(mapB.get(childKey).radix)
          }
        }
      }
    }

    return extraBadKeys
  }

  /***
   *     ######   #######  ##     ## ########  ##     ## ######## ########  ######   #######  ##     ## ######## ########     ###     ######   ########
   *    ##    ## ##     ## ###   ### ##     ## ##     ##    ##    ##       ##    ## ##     ## ##     ## ##       ##     ##   ## ##   ##    ##  ##
   *    ##       ##     ## #### #### ##     ## ##     ##    ##    ##       ##       ##     ## ##     ## ##       ##     ##  ##   ##  ##        ##
   *    ##       ##     ## ## ### ## ########  ##     ##    ##    ######   ##       ##     ## ##     ## ######   ########  ##     ## ##   #### ######
   *    ##       ##     ## ##     ## ##        ##     ##    ##    ##       ##       ##     ##  ##   ##  ##       ##   ##   ######### ##    ##  ##
   *    ##    ## ##     ## ##     ## ##        ##     ##    ##    ##       ##    ## ##     ##   ## ##   ##       ##    ##  ##     ## ##    ##  ##
   *     ######   #######  ##     ## ##         #######     ##    ########  ######   #######     ###    ######## ##     ## ##     ##  ######   ########
   */
  /**
   * computeCoverage
   *
   * Take a look at the winning votes and build of lists of which nodes we can ask for information
   * this happens once per cycle then getNodeForQuery() can be used to cleanly figure out what node to ask for a query given
   * a certain radix value.
   *
   * @param cycle
   */
  computeCoverage(cycle: number): void {
    const hashTrieSyncConsensus = this.hashTrieSyncConsensusByCycle.get(cycle)

    const coverageMap: Map<string, HashTrieRadixCoverage> = new Map() //map of sync radix to n

    hashTrieSyncConsensus.coverageMap = coverageMap

    //let nodeUsage = new Map()
    for (const radixHash of hashTrieSyncConsensus.radixHashVotes.keys()) {
      const coverage = coverageMap.get(radixHash)
      if (coverage == null) {
        const votes = hashTrieSyncConsensus.radixHashVotes.get(radixHash)
        const bestVote = votes.allVotes.get(votes.bestHash)
        const potentialNodes = bestVote.voters
        //shuffle array of potential helpers
        //utils.shuffleArray(potentialNodes) //leaving non random to catch issues in testing.
        const node = potentialNodes[0]
        coverageMap.set(radixHash, { firstChoice: node, fullList: potentialNodes, refuted: new Set() })
        //let count = nodeUsage.get(node.id)
      }
    }

    //todo a pass to use as few nodes as possible

    //todo this new list can be acced with fn and give bakup nods/
    //  have fallback optoins
  }

  /***
   *     ######   ######## ######## ##    ##  #######  ########  ######## ########  #######  ########   #######  ##     ## ######## ########  ##    ##
   *    ##    ##  ##          ##    ###   ## ##     ## ##     ## ##       ##       ##     ## ##     ## ##     ## ##     ## ##       ##     ##  ##  ##
   *    ##        ##          ##    ####  ## ##     ## ##     ## ##       ##       ##     ## ##     ## ##     ## ##     ## ##       ##     ##   ####
   *    ##   #### ######      ##    ## ## ## ##     ## ##     ## ######   ######   ##     ## ########  ##     ## ##     ## ######   ########     ##
   *    ##    ##  ##          ##    ##  #### ##     ## ##     ## ##       ##       ##     ## ##   ##   ##  ## ## ##     ## ##       ##   ##      ##
   *    ##    ##  ##          ##    ##   ### ##     ## ##     ## ##       ##       ##     ## ##    ##  ##    ##  ##     ## ##       ##    ##     ##
   *     ######   ########    ##    ##    ##  #######  ########  ######## ##        #######  ##     ##  ##### ##  #######  ######## ##     ##    ##
   */
  //error handling.. what if we cand find a node or run out?
  /**
   * getNodeForQuery
   * Figure out what node we can ask for a query related to the given radix.
   * this will node that has given us a winning vote for the given radix
   * @param radix
   * @param cycle
   * @param nextNode pass true to start asking the next node in the list for data.
   */
  getNodeForQuery(radix: string, cycle: number, nextNode = false): Shardus.Node | null {
    const hashTrieSyncConsensus = this.hashTrieSyncConsensusByCycle.get(cycle)
    const parentRadix = radix.substring(0, this.treeSyncDepth)

    const coverageEntry = hashTrieSyncConsensus.coverageMap.get(parentRadix)

    if (coverageEntry == null || coverageEntry.firstChoice == null) {
      const numActiveNodes = this.stateManager.currentCycleShardData.nodes.length
      this.statemanager_fatal(
        `getNodeForQuery null ${coverageEntry == null} ${
          coverageEntry?.firstChoice == null
        } numActiveNodes:${numActiveNodes}`,
        `getNodeForQuery null ${coverageEntry == null} ${coverageEntry?.firstChoice == null}`
      )
      return null
    }

    if (nextNode === true) {
      coverageEntry.refuted.add(coverageEntry.firstChoice.id)
      for (let i = 0; i < coverageEntry.fullList.length; i++) {
        const node = coverageEntry.fullList[i] // eslint-disable-line security/detect-object-injection
        if (node == null || coverageEntry.refuted.has(node.id)) {
          continue
        }
        coverageEntry.firstChoice = node
        return coverageEntry.firstChoice
      }
    } else {
      return coverageEntry.firstChoice
    }
    return null
  }

  /**
   * getChildrenOf
   * ask nodes for the child node information of the given list of radix values
   * TODO convert to allSettled?, but support a timeout?
   * @param radixHashEntries
   * @param cycle
   */
  async getChildrenOf(radixHashEntries: RadixAndHash[], cycle: number): Promise<RadixAndHash[]> {
    let nodeHashes: RadixAndHash[] = []
    const requestMap: Map<Shardus.Node, HashTrieReq> = new Map()
    for (const radixHash of radixHashEntries) {
      const node = this.getNodeForQuery(radixHash.radix, cycle)
      if (node == null) {
        this.statemanager_fatal('getChildrenOf node null', 'getChildrenOf node null')
        continue
      }
      let existingRequest = requestMap.get(node)
      if (existingRequest == null) {
        existingRequest = { radixList: [] }
        requestMap.set(node, existingRequest)
      }
      existingRequest.radixList.push(radixHash.radix)
    }
    // for(let [key, value] of requestMap){
    //   try{
    //     result = await this.p2p.ask(key, 'get_trie_hashes', value)
    //     if(result != null && result.nodeHashes != null){
    //       nodeHashes = nodeHashes.concat(result.nodeHashes)
    //     } //else retry?
    //   } catch (error) {
    //     this.statemanager_fatal('getChildrenOf failed', `getChildrenOf failed: ` + errorToStringFull(error))
    //   }
    // }

    const promises = []
    for (const [key, value] of requestMap) {
      try {
        const promise = this.p2p.ask(key, 'get_trie_hashes', value)
        promises.push(promise)
      } catch (error) {
        this.statemanager_fatal('getChildrenOf failed', `getChildrenOf failed: ` + errorToStringFull(error))
      }
    }

    try {
      //TODO should we convert to Promise.allSettled?
      const results = await Promise.all(promises)
      for (const result of results) {
        if (result != null && result.nodeHashes != null) {
          nodeHashes = nodeHashes.concat(result.nodeHashes)
        }
      }
    } catch (error) {
      this.statemanager_fatal('getChildrenOf failed', `getChildrenOf failed: ` + errorToStringFull(error))
    }

    if (nodeHashes.length > 0) {
      nestedCountersInstance.countEvent(`accountPatcher`, `got nodeHashes`, nodeHashes.length)
    } else {
      nestedCountersInstance.countEvent(`accountPatcher`, `failed to get nodeHashes c:${cycle}`, 1)
    }

    return nodeHashes
  }

  /**
   * getChildAccountHashes
   * requests account hashes from one or more nodes.
   * TODO convert to allSettled?, but support a timeout?
   * @param radixHashEntries
   * @param cycle
   */
  async getChildAccountHashes(
    radixHashEntries: RadixAndHash[],
    cycle: number
  ): Promise<{ radixAndChildHashes: RadixAndChildHashes[]; getAccountHashStats: AccountHashStats }> {
    let nodeChildHashes: RadixAndChildHashes[] = []
    const requestMap: Map<Shardus.Node, HashTrieReq> = new Map()
    let actualRadixRequests = 0

    const patcherMaxLeafHashesPerRequest = this.config.stateManager.patcherMaxLeafHashesPerRequest
    for (const radixHash of radixHashEntries) {
      const node = this.getNodeForQuery(radixHash.radix, cycle)
      if (node == null) {
        this.statemanager_fatal('getChildAccountHashes node null', 'getChildAccountHashes node null ')
        continue
      }
      let existingRequest = requestMap.get(node)
      if (existingRequest == null) {
        existingRequest = { radixList: [] }
        requestMap.set(node, existingRequest)
      }

      if (existingRequest.radixList.length > patcherMaxLeafHashesPerRequest) {
        //dont request more than patcherMaxLeafHashesPerRequest  nodes to investigate
        continue
      } else {
        actualRadixRequests++
      }

      existingRequest.radixList.push(radixHash.radix)
    }
    // for(let [key, value] of requestMap){
    //   try{
    //     result = await this.p2p.ask(key, 'get_trie_accountHashes', value)
    //     if(result != null && result.nodeChildHashes != null){
    //       nodeChildHashes = nodeChildHashes.concat(result.nodeChildHashes)
    //       // for(let childHashes of result.nodeChildHashes){
    //       //   allHashes = allHashes.concat(childHashes.childAccounts)
    //       // }
    //     } //else retry?
    //   } catch (error) {
    //     this.statemanager_fatal('getChildAccountHashes failed', `getChildAccountHashes failed: ` + errorToStringFull(error))

    //   }
    // }

    const promises = []
    for (const [key, value] of requestMap) {
      try {
        const promise = this.p2p.ask(key, 'get_trie_accountHashes', value)
        promises.push(promise)
      } catch (error) {
        this.statemanager_fatal(
          'getChildAccountHashes failed',
          `getChildAccountHashes failed: ` + errorToStringFull(error)
        )
      }
    }

    const getAccountHashStats: AccountHashStats = {
      matched: 0,
      visisted: 0,
      empty: 0,
      nullResults: 0,
      numRequests: requestMap.size,
      responses: 0,
      exceptions: 0,
      radixToReq: radixHashEntries.length,
      actualRadixRequests,
    }

    //let result = {nodeChildHashes:[], stats:{ matched:0, visisted:0, empty:0}} as HashTrieAccountsResp

    try {
      //TODO should we convert to Promise.allSettled?
      const results = await Promise.all(promises)
      for (const result of results) {
        if (result != null && result.nodeChildHashes != null) {
          nodeChildHashes = nodeChildHashes.concat(result.nodeChildHashes)
          // for(let childHashes of result.nodeChildHashes){
          //   allHashes = allHashes.concat(childHashes.childAccounts)
          // }
          utils.sumObject(getAccountHashStats, result.stats)
          getAccountHashStats.responses++
        } else {
          getAccountHashStats.nullResults++
        }
      }
    } catch (error) {
      this.statemanager_fatal(
        'getChildAccountHashes failed',
        `getChildAccountHashes failed: ` + errorToStringFull(error)
      )
      getAccountHashStats.exceptions++
    }

    if (nodeChildHashes.length > 0) {
      nestedCountersInstance.countEvent(`accountPatcher`, `got nodeChildHashes`, nodeChildHashes.length)
    }

    if (logFlags.debug) {
      this.mainLogger.debug(`getChildAccountHashes ${utils.stringifyReduce(getAccountHashStats)}`)
    }

    return { radixAndChildHashes: nodeChildHashes, getAccountHashStats: getAccountHashStats }
  }

  /***
   *    ####  ######  #### ##    ##  ######  ##    ## ##    ##  ######
   *     ##  ##    ##  ##  ###   ## ##    ##  ##  ##  ###   ## ##    ##
   *     ##  ##        ##  ####  ## ##         ####   ####  ## ##
   *     ##   ######   ##  ## ## ##  ######     ##    ## ## ## ##
   *     ##        ##  ##  ##  ####       ##    ##    ##  #### ##
   *     ##  ##    ##  ##  ##   ### ##    ##    ##    ##   ### ##    ##
   *    ####  ######  #### ##    ##  ######     ##    ##    ##  ######
   */
  /**
   * isInSync
   *
   * looks at sync level hashes to figure out if any are out of matching.
   * there are cases where this is false but we dig into accounts an realize we do not
   * or can't yet repair something.
   *
   * @param cycle
   */
  isInSync(cycle: number): boolean {
    const hashTrieSyncConsensus = this.hashTrieSyncConsensusByCycle.get(cycle)

    if (hashTrieSyncConsensus == null) {
      return true
    }

    // let nonStoredRanges = this.getNonStoredRanges(cycle)
    // let hasNonStorageRange = false
    // let oosRadix = []
    // get our list of covered radix values for cycle X!!!
    // let inSync = true

    const minVotes = this.calculateMinVotes()

    for (const radix of hashTrieSyncConsensus.radixHashVotes.keys()) {
      const votesMap = hashTrieSyncConsensus.radixHashVotes.get(radix)
      const ourTrieNode = this.shardTrie.layerMaps[this.treeSyncDepth].get(radix)

      //if we dont have the node we may have missed an account completely!
      if (ourTrieNode == null) {
        return false
      }

      if (votesMap.bestVotes < minVotes) {
        //temporary rare event so we can consider this.
        /* prettier-ignore */ nestedCountersInstance.countRareEvent(`accountPatcher`, `isInSync ${radix} votesMap.bestVotes < minVotes bestVotes: ${votesMap.bestVotes} < ${minVotes} uniqueVotes: ${votesMap.allVotes.size}`, 1)
      }

      // hasNonStorageRange = false
      // //does our stored or consensus data actualy cover this range?
      // for(let range of nonStoredRanges){
      //   if(radix >= range.low && radix <= range.high){
      //     hasNonStorageRange = true
      //     continue
      //   }
      // }
      // if(hasNonStorageRange){
      //   //we dont store the full data needed by this radix so we cant repair it
      //   continue
      // }

      //TODO should not have to re compute this here!!
      ourTrieNode.hash = this.crypto.hash(ourTrieNode.childHashes)

      if (ourTrieNode.hash != votesMap.bestHash) {
        //inSync = false
        //oosRadix.push()
        if (logFlags.debug) {
          //overkill, need it for now
          const kvp = []
          for (const [key, value] of votesMap.allVotes.entries()) {
            kvp.push({
              id: key,
              count: value.count,
              nodeIDs: value.voters.map((node) => utils.makeShortHash(node.id) + ':' + node.externalPort),
            })
          }
          const simpleMap = {
            bestHash: votesMap.bestHash,
            bestVotes: votesMap.bestVotes,
            allVotes: kvp,
          }
          /* prettier-ignore */ nestedCountersInstance.countEvent(`accountPatcher`, `isInSync ${radix} ${utils.makeShortHash(votesMap.bestHash)} ourTrieNode.hash:${utils.makeShortHash(ourTrieNode.hash)} uniqueVotes: ${votesMap.allVotes.size}`, 1)
          this.statemanager_fatal(
            'isInSync',
            `isInSync fail ${cycle}: ${radix}  uniqueVotes: ${votesMap.allVotes.size} ${utils.stringifyReduce(
              simpleMap
            )}`
          )
        }
        return false
      }
    }
    //todo what about situation where we do not have enough votes??
    //todo?? more utility / get list of oos radix
    return true // {inSync, }
  }

  /***
   *    ######## #### ##    ## ########  ########     ###    ########     ###     ######   ######   #######  ##     ## ##    ## ########  ######
   *    ##        ##  ###   ## ##     ## ##     ##   ## ##   ##     ##   ## ##   ##    ## ##    ## ##     ## ##     ## ###   ##    ##    ##    ##
   *    ##        ##  ####  ## ##     ## ##     ##  ##   ##  ##     ##  ##   ##  ##       ##       ##     ## ##     ## ####  ##    ##    ##
   *    ######    ##  ## ## ## ##     ## ########  ##     ## ##     ## ##     ## ##       ##       ##     ## ##     ## ## ## ##    ##     ######
   *    ##        ##  ##  #### ##     ## ##     ## ######### ##     ## ######### ##       ##       ##     ## ##     ## ##  ####    ##          ##
   *    ##        ##  ##   ### ##     ## ##     ## ##     ## ##     ## ##     ## ##    ## ##    ## ##     ## ##     ## ##   ###    ##    ##    ##
   *    ##       #### ##    ## ########  ########  ##     ## ########  ##     ##  ######   ######   #######   #######  ##    ##    ##     ######
   */
  /**
   * findBadAccounts
   *
   * starts at the sync level hashes that dont match and queries for child nodes to get more details about
   * what accounts could possibly be bad.  At the lowest level gets a list of accounts and hashes
   * We double check out cache values before returning a list of bad accounts that need repairs.
   *
   * @param cycle
   */
  async findBadAccounts(cycle: number): Promise<BadAccountsInfo> {
    let badAccounts: AccountIDAndHash[] = []
    const hashesPerLevel: number[] = Array(this.treeMaxDepth + 1).fill(0)
    const checkedKeysPerLevel = Array(this.treeMaxDepth)
    const badHashesPerLevel: number[] = Array(this.treeMaxDepth + 1).fill(0)
    const requestedKeysPerLevel: number[] = Array(this.treeMaxDepth + 1).fill(0)

    let level = this.treeSyncDepth
    let badLayerMap = this.shardTrie.layerMaps[level] // eslint-disable-line security/detect-object-injection
    const syncTrackerRanges = this.getSyncTrackerRanges()

    const stats = {
      testedSyncRadix: 0,
      skippedSyncRadix: 0,
      badSyncRadix: 0,
      ok_noTrieAcc: 0,
      ok_trieHashBad: 0,
      fix_butHashMatch: 0,
      fixLastSeen: 0,
      needsVotes: 0,
      subHashesTested: 0,
      trailColdLevel: 0,
      checkedLevel: 0,
      leafsChecked: 0,
      leafResponses: 0,
      getAccountHashStats: {},
    }
    let extraBadKeys = []

    const minVotes = this.calculateMinVotes()

    const goodVotes: RadixAndHash[] = []
    const hashTrieSyncConsensus = this.hashTrieSyncConsensusByCycle.get(cycle)
    for (const radix of hashTrieSyncConsensus.radixHashVotes.keys()) {
      const votesMap = hashTrieSyncConsensus.radixHashVotes.get(radix)
      let isSyncingRadix = false

      if (votesMap.bestVotes < minVotes) {
        stats.needsVotes++
        if (logFlags.debug) {
          //overkill, need it for now
          const kvp = []
          for (const [key, value] of votesMap.allVotes.entries()) {
            kvp.push({
              id: key,
              count: value.count,
              nodeIDs: value.voters.map((node) => utils.makeShortHash(node.id) + ':' + node.externalPort),
            })
          }
          const simpleMap = {
            bestHash: votesMap.bestHash,
            bestVotes: votesMap.bestVotes,
            allVotes: kvp,
          }
          /* prettier-ignore */ nestedCountersInstance.countEvent(`accountPatcher`, `not enough votes ${radix} ${utils.makeShortHash(votesMap.bestHash)} uniqueVotes: ${votesMap.allVotes.size}`, 1)
          this.statemanager_fatal(
            'debug findBadAccounts',
            `debug findBadAccounts ${cycle}: ${radix} bestVotes${
              votesMap.bestVotes
            } < minVotes:${minVotes} uniqueVotes: ${votesMap.allVotes.size} ${utils.stringifyReduce(
              simpleMap
            )}`
          )
        }
        continue
      }

      //do we need to filter out a vote?
      for (const range of syncTrackerRanges) {
        if (radix >= range.low && radix <= range.high) {
          isSyncingRadix = true
          break
        }
      }
      if (isSyncingRadix === true) {
        stats.skippedSyncRadix++
        continue
      }
      stats.testedSyncRadix++
      goodVotes.push({ radix, hash: votesMap.bestHash })
    }

    let toFix = this.diffConsenus(goodVotes, badLayerMap)

    stats.badSyncRadix = toFix.length

    if (logFlags.debug) {
      toFix.sort(this.sortByRadix)
      this.statemanager_fatal(
        'debug findBadAccounts',
        `debug findBadAccounts ${cycle}: ${utils.stringifyReduce(toFix)}`
      )
    }

    //record some debug info
    badHashesPerLevel[level] = toFix.length // eslint-disable-line security/detect-object-injection
    checkedKeysPerLevel[level] = toFix.map((x) => x.radix) // eslint-disable-line security/detect-object-injection
    requestedKeysPerLevel[level] = goodVotes.length // eslint-disable-line security/detect-object-injection
    hashesPerLevel[level] = goodVotes.length // eslint-disable-line security/detect-object-injection

    this.computeCoverage(cycle)

    stats.checkedLevel = level
    //refine our query until we get to the lowest level
    while (level < this.treeMaxDepth && toFix.length > 0) {
      level++
      stats.checkedLevel = level
      badLayerMap = this.shardTrie.layerMaps[level] // eslint-disable-line security/detect-object-injection
      const childrenToDiff = await this.getChildrenOf(toFix, cycle)

      toFix = this.diffConsenus(childrenToDiff, badLayerMap)

      stats.subHashesTested += toFix.length

      if (toFix.length === 0) {
        stats.trailColdLevel = level
        extraBadKeys = this.findExtraBadKeys(childrenToDiff, badLayerMap)
      }

      //record some debug info
      badHashesPerLevel[level] = toFix.length // eslint-disable-line security/detect-object-injection
      checkedKeysPerLevel[level] = toFix.map((x) => x.radix) // eslint-disable-line security/detect-object-injection
      requestedKeysPerLevel[level] = childrenToDiff.length // eslint-disable-line security/detect-object-injection
      hashesPerLevel[level] = childrenToDiff.length // eslint-disable-line security/detect-object-injection
      // badLayerMap.size ...badLayerMap could be null!
    }

    stats.leafsChecked = toFix.length
    //get bad accounts
    const { radixAndChildHashes, getAccountHashStats } = await this.getChildAccountHashes(toFix, cycle)
    stats.getAccountHashStats = getAccountHashStats

    stats.leafResponses = radixAndChildHashes.length

    let accountHashesChecked = 0
    for (const radixAndChildHash of radixAndChildHashes) {
      accountHashesChecked += radixAndChildHash.childAccounts.length

      const badTreeNode = badLayerMap.get(radixAndChildHash.radix)
      if (badTreeNode != null) {
        const accMap = new Map()
        if (badTreeNode.accounts != null) {
          for (let i = 0; i < badTreeNode.accounts.length; i++) {
            accMap.set(badTreeNode.accounts[i].accountID, badTreeNode.accounts[i]) // eslint-disable-line security/detect-object-injection
          }
        }
        for (let i = 0; i < radixAndChildHash.childAccounts.length; i++) {
          const potentalGoodAcc = radixAndChildHash.childAccounts[i] // eslint-disable-line security/detect-object-injection
          const potentalBadAcc = accMap.get(potentalGoodAcc.accountID)

          //check if our cache value has matching hash already.  The trie can lag behind.
          //  todo would be nice to find a way to reduce this, possibly by better control of syncing ranges.
          //   (we are not supposed to test syncing ranges , but maybe that is out of phase?)

          //only do this check if the account is new.  It was skipping potential oos situations.
          const accountMemData: AccountHashCache = this.stateManager.accountCache.getAccountHash(
            potentalGoodAcc.accountID
          )
          if (accountMemData != null && accountMemData.h === potentalGoodAcc.hash) {
            if (accountMemData.c >= cycle - 1) {
              if (potentalBadAcc != null) {
                if (potentalBadAcc.hash != potentalGoodAcc.hash) {
                  stats.ok_trieHashBad++
                }
              } else {
                stats.ok_noTrieAcc++
              }

              //this was in cache, but stale so we can reinstate the cache since it still matches the group consensus
              const accountHashCacheHistory: AccountHashCacheHistory =
                this.stateManager.accountCache.getAccountHashHistoryItem(potentalGoodAcc.accountID)
              if (
                accountHashCacheHistory != null &&
                accountHashCacheHistory.lastStaleCycle >= accountHashCacheHistory.lastSeenCycle
              ) {
                stats.fixLastSeen++
                accountHashCacheHistory.lastSeenCycle = cycle
              }
              //skip out
              continue
            } else {
              //dont skip out!
              //cache matches but trie hash is bad
              stats.fix_butHashMatch++
              //actually we can repair trie here:
              this.updateAccountHash(potentalGoodAcc.accountID, potentalGoodAcc.hash)
              continue
            }
          }

          //is the account missing or wrong hash?
          if (potentalBadAcc != null) {
            if (potentalBadAcc.hash != potentalGoodAcc.hash) {
              badAccounts.push(potentalGoodAcc)
            }
          } else {
            badAccounts.push(potentalGoodAcc)
          }
        }
      } else {
        badAccounts = badAccounts.concat(radixAndChildHash.childAccounts)
      }
    }
    return {
      badAccounts,
      hashesPerLevel,
      checkedKeysPerLevel,
      requestedKeysPerLevel,
      badHashesPerLevel,
      accountHashesChecked,
      stats,
      extraBadKeys,
    }
  }

  //big todo .. be able to test changes on a temp tree and validate the hashed before we commit updates
  //also need to actually update the full account data and not just our tree!!

  /***
   *    ##     ## ########  ########     ###    ######## ########    ###     ######   ######   #######  ##     ## ##    ## ######## ##     ##    ###     ######  ##     ##
   *    ##     ## ##     ## ##     ##   ## ##      ##    ##         ## ##   ##    ## ##    ## ##     ## ##     ## ###   ##    ##    ##     ##   ## ##   ##    ## ##     ##
   *    ##     ## ##     ## ##     ##  ##   ##     ##    ##        ##   ##  ##       ##       ##     ## ##     ## ####  ##    ##    ##     ##  ##   ##  ##       ##     ##
   *    ##     ## ########  ##     ## ##     ##    ##    ######   ##     ## ##       ##       ##     ## ##     ## ## ## ##    ##    ######### ##     ##  ######  #########
   *    ##     ## ##        ##     ## #########    ##    ##       ######### ##       ##       ##     ## ##     ## ##  ####    ##    ##     ## #########       ## ##     ##
   *    ##     ## ##        ##     ## ##     ##    ##    ##       ##     ## ##    ## ##    ## ##     ## ##     ## ##   ###    ##    ##     ## ##     ## ##    ## ##     ##
   *     #######  ##        ########  ##     ##    ##    ######## ##     ##  ######   ######   #######   #######  ##    ##    ##    ##     ## ##     ##  ######  ##     ##
   */
  /**
   * updateAccountHash
   * This is the main function called externally to tell the hash trie what the hash value is for a given accountID
   *
   * @param accountID
   * @param hash
   *
   */
  updateAccountHash(accountID: string, hash: string): void {
    //todo do we need to look at cycle or timestamp and have a future vs. next queue?
    if (this.debug_ignoreUpdates) {
      this.statemanager_fatal(`patcher ignored: tx`, `patcher ignored: ${accountID} hash:${hash}`)
      return
    }

    const accountData = { accountID, hash }
    this.accountUpdateQueue.push(accountData)
  }

  removeAccountHash(accountID: string): void {
    this.accountRemovalQueue.push(accountID)
  }
  // applyRepair(accountsToFix:AccountIDAndHash[]){
  //   //todo do we need to look at cycle or timestamp and have a future vs. next queue?
  //   for(let account of accountsToFix){
  //     //need proper tx injestion.
  //     //this.txCommit(node, account)
  //     this.updateAccountHash(account.accountID, account.hash)
  //   }
  // }

  //test if radix is covered by our node.. that is tricky...
  //need isincomplete logic integrated with trie generation.
  //will be 1 or 2 values only

  // type HashTrieSyncTell = {
  //   cycle: number
  //   nodeHashes: {radix:string, hash:string}[]
  // }

  /***
   *    ########  ########   #######     ###    ########   ######     ###     ######  ########  ######  ##    ## ##    ##  ######  ##     ##    ###     ######  ##     ## ########  ######
   *    ##     ## ##     ## ##     ##   ## ##   ##     ## ##    ##   ## ##   ##    ##    ##    ##    ##  ##  ##  ###   ## ##    ## ##     ##   ## ##   ##    ## ##     ## ##       ##    ##
   *    ##     ## ##     ## ##     ##  ##   ##  ##     ## ##        ##   ##  ##          ##    ##         ####   ####  ## ##       ##     ##  ##   ##  ##       ##     ## ##       ##
   *    ########  ########  ##     ## ##     ## ##     ## ##       ##     ##  ######     ##     ######     ##    ## ## ## ##       ######### ##     ##  ######  ######### ######    ######
   *    ##     ## ##   ##   ##     ## ######### ##     ## ##       #########       ##    ##          ##    ##    ##  #### ##       ##     ## #########       ## ##     ## ##             ##
   *    ##     ## ##    ##  ##     ## ##     ## ##     ## ##    ## ##     ## ##    ##    ##    ##    ##    ##    ##   ### ##    ## ##     ## ##     ## ##    ## ##     ## ##       ##    ##
   *    ########  ##     ##  #######  ##     ## ########   ######  ##     ##  ######     ##     ######     ##    ##    ##  ######  ##     ## ##     ##  ######  ##     ## ########  ######
   */
  /**
   * broadcastSyncHashes
   * after each tree computation we figure out what radix + hash values we can send out
   * these will be nodes at the treeSyncDepth (which is higher up than our leafs, and is efficient, but also adjusts to support sharding)
   * there are important conditions about when we can send a value for a given radix and who we can send it to.
   *
   * @param cycle
   */
  async broadcastSyncHashes(cycle: number): Promise<void> {
    const syncLayer = this.shardTrie.layerMaps[this.treeSyncDepth]

    const shardGlobals = this.stateManager.currentCycleShardData.shardGlobals

    const messageToNodeMap: Map<string, { node: Shardus.Node; message: HashTrieSyncTell }> = new Map()

    const radixUsed: Map<string, Set<string>> = new Map()

    const nonConsensusRanges = this.getNonConsensusRanges(cycle)
    const nonStoredRanges = this.getNonStoredRanges(cycle)
    const syncTrackerRanges = this.getSyncTrackerRanges()
    let hasNonConsensusRange = false
    let lastCycleNonConsensus = false
    let hasNonStorageRange = false
    let inSyncTrackerRange = false

    const debugSyncSkipSet = new Set<string>()
    const debugRadixSet = new Set<string>()

    const stats = {
      broadcastSkip: 0,
    }
    for (const treeNode of syncLayer.values()) {
      hasNonConsensusRange = false
      lastCycleNonConsensus = false
      hasNonStorageRange = false
      inSyncTrackerRange = false

      //There are several conditions below when we do not qualify to send out a hash for a given radix.
      //In general we send hashes for nodes that are fully covered in our consensus range.
      //Due to network shifting if we were consenus last cycle but still fully stored range we can send a hash.
      //Syncing operation will prevent us from sending a hash (because in theory we dont have complete account data)

      for (const range of this.lastCycleNonConsensusRanges) {
        if (treeNode.radix >= range.low && treeNode.radix <= range.high) {
          lastCycleNonConsensus = true
        }
      }
      for (const range of nonStoredRanges) {
        if (treeNode.radix >= range.low && treeNode.radix <= range.high) {
          hasNonStorageRange = true
        }
      }
      for (const range of nonConsensusRanges) {
        if (treeNode.radix >= range.low && treeNode.radix <= range.high) {
          hasNonConsensusRange = true
        }
      }

      //do we need to adjust what cycle we are looking at for syncing?
      for (const range of syncTrackerRanges) {
        if (treeNode.radix >= range.low && treeNode.radix <= range.high) {
          inSyncTrackerRange = true
        }
      }
      if (inSyncTrackerRange) {
        stats.broadcastSkip++
        if (logFlags.verbose && logFlags.playback) {
          debugSyncSkipSet.add(treeNode.radix)
        }
        continue
      }

      if (hasNonConsensusRange) {
        if (lastCycleNonConsensus === false && hasNonStorageRange === false) {
          //we can share this data, may be a pain for nodes to verify..
          //todo include last cycle syncing..
        } else {
          //we cant send this data
          continue
        }
      }

      debugRadixSet.add(`${treeNode.radix}:${utils.stringifyReduce(treeNode.hash)}`)

      //figure out who to send a hash to
      //build up a map of messages
      const partitionRange = ShardFunctions.getPartitionRangeFromRadix(shardGlobals, treeNode.radix)
      for (let i = partitionRange.low; i <= partitionRange.high; i++) {
        const shardInfo = this.stateManager.currentCycleShardData.parititionShardDataMap.get(i)

        let sendToMap = shardInfo.coveredBy
        if (this.sendHashesToEdgeNodes) {
          sendToMap = shardInfo.storedBy
        }

        for (const value of Object.values(sendToMap)) {
          let messagePair = messageToNodeMap.get(value.id)
          if (messagePair == null) {
            messagePair = { node: value, message: { cycle, nodeHashes: [] } }
            messageToNodeMap.set(value.id, messagePair)
          }
          // todo done send duplicate node hashes to the same node?

          let radixSeenSet = radixUsed.get(value.id)
          if (radixSeenSet == null) {
            radixSeenSet = new Set()
            radixUsed.set(value.id, radixSeenSet)
          }
          if (radixSeenSet.has(treeNode.radix) === false) {
            //extra safety step! todo remove for perf.
            treeNode.hash = this.hashObj(treeNode.childHashes)
            messagePair.message.nodeHashes.push({ radix: treeNode.radix, hash: treeNode.hash })
            radixSeenSet.add(treeNode.radix)
          }
        }
      }
    }

    if (stats.broadcastSkip > 0) {
      nestedCountersInstance.countEvent(`accountPatcher`, `broadcast skip syncing`, stats.broadcastSkip)
      /* prettier-ignore */ if (logFlags.verbose) if (logFlags.playback) this.logger.playbackLogNote('accountPatcher', ``, `broadcast skip syncing c:${cycle} set: ${utils.stringifyReduce(debugSyncSkipSet)}`)
    }

    //radixUsed
    /* prettier-ignore */ if (logFlags.verbose) if (logFlags.playback) this.logger.playbackLogNote('accountPatcher', ``, `broadcast radixUsed syncing c:${cycle} set: ${[utils.stringifyReduce([...debugRadixSet.keys()])]}`)

    //send the messages we have built up.  (parallel waiting with promise.all)
    const promises = []
    for (const messageEntry of messageToNodeMap.values()) {
      const promise = this.p2p.tell([messageEntry.node], 'sync_trie_hashes', messageEntry.message)
      promises.push(promise)
    }
    await Promise.all(promises)
  }

  /***
   *    ##     ## ########  ########     ###    ######## ######## ######## ########  #### ########    ###    ##    ## ########  ########  ########   #######     ###    ########   ######     ###     ######  ########
   *    ##     ## ##     ## ##     ##   ## ##      ##    ##          ##    ##     ##  ##  ##         ## ##   ###   ## ##     ## ##     ## ##     ## ##     ##   ## ##   ##     ## ##    ##   ## ##   ##    ##    ##
   *    ##     ## ##     ## ##     ##  ##   ##     ##    ##          ##    ##     ##  ##  ##        ##   ##  ####  ## ##     ## ##     ## ##     ## ##     ##  ##   ##  ##     ## ##        ##   ##  ##          ##
   *    ##     ## ########  ##     ## ##     ##    ##    ######      ##    ########   ##  ######   ##     ## ## ## ## ##     ## ########  ########  ##     ## ##     ## ##     ## ##       ##     ##  ######     ##
   *    ##     ## ##        ##     ## #########    ##    ##          ##    ##   ##    ##  ##       ######### ##  #### ##     ## ##     ## ##   ##   ##     ## ######### ##     ## ##       #########       ##    ##
   *    ##     ## ##        ##     ## ##     ##    ##    ##          ##    ##    ##   ##  ##       ##     ## ##   ### ##     ## ##     ## ##    ##  ##     ## ##     ## ##     ## ##    ## ##     ## ##    ##    ##
   *     #######  ##        ########  ##     ##    ##    ########    ##    ##     ## #### ######## ##     ## ##    ## ########  ########  ##     ##  #######  ##     ## ########   ######  ##     ##  ######     ##
   */
  /**
   * updateTrieAndBroadCast
   * calculates what our tree leaf(max) depth and sync depths are.
   *   if there is a change we have to do some partition work to send old leaf data to new leafs.
   * Then calls upateShardTrie() and broadcastSyncHashes()
   *
   * @param cycle
   */
  async updateTrieAndBroadCast(cycle: number): Promise<void> {
    //calculate sync levels!!
    const shardValues = this.stateManager.shardValuesByCycle.get(cycle)
    const shardGlobals = shardValues.shardGlobals as StateManagerTypes.shardFunctionTypes.ShardGlobals

    const minHashesPerRange = 4
    // y = floor(log16((minHashesPerRange * max(1, x/consensusRange   ))))
    let syncDepthRaw =
      Math.log(
        minHashesPerRange * Math.max(1, shardGlobals.numPartitions / (shardGlobals.consensusRadius * 2 + 1))
      ) / Math.log(16)
    syncDepthRaw = Math.max(1, syncDepthRaw) // at least 1
    const newSyncDepth = Math.ceil(syncDepthRaw)

    //This only happens when the depth of our tree change (based on num nodes above)
    //We have to partition the leaf node data into leafs of the correct level and rebuild the tree
    if (this.treeSyncDepth != newSyncDepth) {
      //todo add this in to prevent size flipflop..(better: some deadspace)  && newSyncDepth > this.treeSyncDepth){
      const resizeStats = {
        nodesWithAccounts: 0,
        nodesWithoutAccounts: 0,
      }
      const newMaxDepth = newSyncDepth + 3 //todo the "+3" should be based on total number of stored accounts pre node (in a consensed way, needs to be on cycle chain)
      //add more maps if needed  (+1 because we have a map level 0)
      while (this.shardTrie.layerMaps.length < newMaxDepth + 1) {
        this.shardTrie.layerMaps.push(new Map())
      }

      //detach all accounts.
      const currentLeafMap = this.shardTrie.layerMaps[this.treeMaxDepth]

      //put all accounts into queue to rebuild Tree!
      for (const treeNode of currentLeafMap.values()) {
        if (treeNode.accounts != null) {
          for (const account of treeNode.accounts) {
            //this.updateAccountHash(account.accountID, account.hash)

            //need to unshift these, becasue they could be older than what is alread in the queue!!
            this.accountUpdateQueue.unshift(account)
          }
          // //clear out leaf node only properties:
          // treeNode.accounts = null
          // treeNode.accountTempMap = null

          // //have to init these nodes to work as parents
          // treeNode.children = Array(16)
          // treeNode.childHashes = Array(16)

          //nestedCountersInstance.countEvent(`accountPatcher`, `updateTrieAndBroadCast: ok account list?`)
          resizeStats.nodesWithAccounts++
        } else {
          //nestedCountersInstance.countEvent(`accountPatcher`, `updateTrieAndBroadCast: null account list?`)
          resizeStats.nodesWithoutAccounts++
        }
      }

      //better to just wipe out old parent nodes!
      for (let idx = 0; idx < newMaxDepth; idx++) {
        this.shardTrie.layerMaps[idx].clear() // eslint-disable-line security/detect-object-injection
      }

      if (newMaxDepth < this.treeMaxDepth) {
        //cant get here, but consider deleting layers out of the map
        /* prettier-ignore */ nestedCountersInstance.countEvent(`accountPatcher`, `max depth decrease oldMaxDepth:${this.treeMaxDepth} maxDepth :${newMaxDepth} stats:${utils.stringifyReduce(resizeStats)} cycle:${cycle}`)
      } else {
        /* prettier-ignore */ nestedCountersInstance.countEvent(`accountPatcher`, `max depth increase oldMaxDepth:${this.treeMaxDepth} maxDepth :${newMaxDepth} stats:${utils.stringifyReduce(resizeStats)} cycle:${cycle}`)
      }

      this.treeSyncDepth = newSyncDepth
      this.treeMaxDepth = newMaxDepth
    }

    /* prettier-ignore */ nestedCountersInstance.countEvent(`accountPatcher`, ` syncDepth:${this.treeSyncDepth} maxDepth :${this.treeMaxDepth}`)

    // Update the trie with new account data updates since the last cycle
    const updateStats = this.upateShardTrie(cycle)

    /* prettier-ignore */ nestedCountersInstance.countEvent(`accountPatcher`, `totalAccountsHashed`, updateStats.totalAccountsHashed)

    //broadcast sync data to nodes that cover similar portions of the tree
    await this.broadcastSyncHashes(cycle)
  }

  /***
   *    ######## ########  ######  ########    ###    ##    ## ########  ########     ###    ########  ######  ##     ##    ###     ######   ######   #######  ##     ## ##    ## ########  ######
   *       ##    ##       ##    ##    ##      ## ##   ###   ## ##     ## ##     ##   ## ##      ##    ##    ## ##     ##   ## ##   ##    ## ##    ## ##     ## ##     ## ###   ##    ##    ##    ##
   *       ##    ##       ##          ##     ##   ##  ####  ## ##     ## ##     ##  ##   ##     ##    ##       ##     ##  ##   ##  ##       ##       ##     ## ##     ## ####  ##    ##    ##
   *       ##    ######    ######     ##    ##     ## ## ## ## ##     ## ########  ##     ##    ##    ##       ######### ##     ## ##       ##       ##     ## ##     ## ## ## ##    ##     ######
   *       ##    ##             ##    ##    ######### ##  #### ##     ## ##        #########    ##    ##       ##     ## ######### ##       ##       ##     ## ##     ## ##  ####    ##          ##
   *       ##    ##       ##    ##    ##    ##     ## ##   ### ##     ## ##        ##     ##    ##    ##    ## ##     ## ##     ## ##    ## ##    ## ##     ## ##     ## ##   ###    ##    ##    ##
   *       ##    ########  ######     ##    ##     ## ##    ## ########  ##        ##     ##    ##     ######  ##     ## ##     ##  ######   ######   #######   #######  ##    ##    ##     ######
   */
  /**
   * testAndPatchAccounts
   * does a quick check to see if we are isInSync() with the sync level votes we have been given.
   * if we are out of sync it uses findBadAccounts to recursively find what accounts need repair.
   * we then query nodes for the account data we need to do a repair with
   * finally we check the repair data and use it to repair out accounts.
   *
   * @param cycle
   */
  async testAndPatchAccounts(cycle: number): Promise<void> {
    // let updateStats = this.upateShardTrie(cycle)
    // nestedCountersInstance.countEvent(`accountPatcher`, `totalAccountsHashed`, updateStats.totalAccountsHashed)

    const lastFail = this.failedLastTrieSync

    this.failedLastTrieSync = false

    const trieRepairDump = {
      cycle,
      stats: null,
      z_accountSummary: null,
    }

    if (logFlags.debug) {
      const hashTrieSyncConsensus = this.hashTrieSyncConsensusByCycle.get(cycle)
      const debug = []
      if (hashTrieSyncConsensus && hashTrieSyncConsensus.radixHashVotes) {
        for (const [key, value] of hashTrieSyncConsensus.radixHashVotes) {
          debug.push({ radix: key, hash: value.bestHash, votes: value.bestVotes })
        }
      }
      debug.sort(this.sortByRadix)
      this.statemanager_fatal(
        'debug shardTrie',
        `temp shardTrie votes c:${cycle}: ${utils.stringifyReduce(debug)}`
      )
    }

    if (this.isInSync(cycle) === false) {
      if (this.stateManager.debugSkipPatcherRepair) {
        this.failedLastTrieSync = true
        return
      }
      let failHistoryObject: { repaired: number; s: number; e: number; cycles: number }
      if (lastFail === false) {
        this.failStartCycle = cycle
        this.failEndCycle = -1
        this.failRepairsCounter = 0
        failHistoryObject = {
          s: this.failStartCycle,
          e: this.failEndCycle,
          cycles: 1,
          repaired: this.failRepairsCounter,
        }
        this.syncFailHistory.push(failHistoryObject)
      } else {
        failHistoryObject = this.syncFailHistory[this.syncFailHistory.length - 1]
      }

      const results = await this.findBadAccounts(cycle)
      /* prettier-ignore */ nestedCountersInstance.countEvent(`accountPatcher`, `badAccounts c:${cycle} `, results.badAccounts.length)
      /* prettier-ignore */ nestedCountersInstance.countEvent(`accountPatcher`, `accountHashesChecked c:${cycle}`, results.accountHashesChecked)

      if (this.config.mode === 'debug' && this.config.debug.haltOnDataOOS) {
        this.statemanager_fatal(
          'testAndPatchAccounts',
          'Data OOS detected. We are halting the repair process on purpose'
        )
        this.failedLastTrieSync = true
        return
      }

      this.stateManager.cycleDebugNotes.badAccounts = results.badAccounts.length //per cycle debug info
      //TODO figure out if the possible repairs will fully repair a given hash for a radix.
      // This could add some security but my concern is that it could create a situation where something unexpected prevents
      // repairing some of the data.
      // const preTestResults = this.simulateRepairs(cycle, results.badAccounts)

      if (results.extraBadKeys.length > 0) {
        this.statemanager_fatal(
          'checkAndSetAccountData extra bad keys',
          `c:${cycle} extra bad keys: ${JSON.stringify(results.extraBadKeys)}  `
        )
      }

      //request data for the list of bad accounts then update.
      const { wrappedDataList, stateTableDataMap, getAccountStats } = await this.getAccountRepairData(
        cycle,
        results.badAccounts
      )

      //we need filter our list of possible account data to use for corrections.
      //it is possible the majority voters could send us account data that is older than what we have.
      //todo must sort out if we can go backwards...  (I had dropped some pre validation earlier, but need to rethink that)
      const wrappedDataListFiltered: Shardus.WrappedData[] = []
      const noChange = new Set()
      const updateTooOld = new Set()
      const filterStats = {
        accepted: 0,
        tooOld: 0,
        sameTS: 0,
        sameTSFix: 0,
        tsFix2: 0,
        tsFix3: 0,
      }

      // build a list of data that is good to use in this repair operation
      // Also, there is a section where cache accountHashCacheHistory.lastSeenCycle may get repaired.
      for (const wrappedData of wrappedDataList) {
        if (this.stateManager.accountCache.hasAccount(wrappedData.accountId)) {
          const accountMemData: AccountHashCache = this.stateManager.accountCache.getAccountHash(
            wrappedData.accountId
          )
          // dont allow an older timestamp to overwrite a newer copy of data we have.
          // we may need to do more work to make sure this can not cause an un repairable situation
          if (wrappedData.timestamp < accountMemData.t) {
            updateTooOld.add(wrappedData.accountId)
            // nestedCountersInstance.countEvent('accountPatcher', `checkAndSetAccountData updateTooOld c:${cycle}`)
            this.statemanager_fatal(
              'checkAndSetAccountData updateTooOld',
              `checkAndSetAccountData updateTooOld ${cycle}: acc:${utils.stringifyReduce(
                wrappedData.accountId
              )} updateTS:${wrappedData.timestamp} updateHash:${utils.stringifyReduce(
                wrappedData.stateId
              )}  cacheTS:${accountMemData.t} cacheHash:${utils.stringifyReduce(accountMemData.h)}`
            )
            filterStats.tooOld++
            continue
          }
          //This is less likely to be hit here now that similar logic checking the hash happens upstream in findBadAccounts()
          if (wrappedData.timestamp === accountMemData.t) {
            let allowPatch = false
            // if we got here make sure to update the last seen cycle in case the cache needs to know it has current enough data
            const accountHashCacheHistory: AccountHashCacheHistory =
              this.stateManager.accountCache.getAccountHashHistoryItem(wrappedData.accountId)
            if (
              accountHashCacheHistory != null &&
              accountHashCacheHistory.lastStaleCycle >= accountHashCacheHistory.lastSeenCycle
            ) {
              // /* prettier-ignore */ nestedCountersInstance.countEvent('accountPatcher', `checkAndSetAccountData updateSameTS update lastSeenCycle c:${cycle}`)
              filterStats.sameTSFix++
              accountHashCacheHistory.lastSeenCycle = cycle
            } else if (
              accountHashCacheHistory != null &&
              accountHashCacheHistory.accountHashList.length > 0 &&
              wrappedData.stateId != accountHashCacheHistory.accountHashList[0].h
            ) {
              // not sure if this is the correct fix but testing will let us know more
              nestedCountersInstance.countRareEvent('accountPatcher', `tsFix2`)
              nestedCountersInstance.countEvent('accountPatcher', `tsFix2 c:${cycle}`)
              //not really fatal. but want to validate info
              this.statemanager_fatal(
                'accountPatcher_tsFix2',
                `tsFix2 c:${cycle} wrappedData:${utils.stringifyReduce(
                  wrappedData
                )} accountHashCacheHistory:${utils.stringifyReduce(accountHashCacheHistory)}`
              )
              filterStats.tsFix2++
              accountHashCacheHistory.lastSeenCycle = cycle
              allowPatch = true

              //this.stateManager.accountCache.updateAccountHash()

              //We need to patch the hash value to what it will be..  TODO think more if there is a better way to do this.
              accountMemData.h = wrappedData.stateId
            } else {
              //just dont even care and bump the last seen cycle up.. this might do nothing
              nestedCountersInstance.countRareEvent('accountPatcher', `tsFix3`)
              //not really fatal. but want to validate info
              this.statemanager_fatal(
                'accountPatcher_tsFix3',
                `tsFix3 c:${cycle} wrappedData:${utils.stringifyReduce(
                  wrappedData
                )} accountHashCacheHistory:${utils.stringifyReduce(accountHashCacheHistory)}`
              )
              filterStats.tsFix3++
              accountHashCacheHistory.lastSeenCycle = cycle
            }

            if (allowPatch === false) {
              noChange.add(wrappedData.accountId)
              // nestedCountersInstance.countEvent('accountPatcher', `checkAndSetAccountData updateSameTS c:${cycle}`)
              continue
            }
            filterStats.sameTS++
          }
          filterStats.accepted++
          //we can proceed with the update
          wrappedDataListFiltered.push(wrappedData)
        } else {
          filterStats.accepted++
          //this good account data to repair with
          wrappedDataListFiltered.push(wrappedData)
        }
      }

      const updatedAccounts: string[] = []
      //save the account data.  note this will make sure account hashes match the wrappers and return failed hashes  that dont match
      const failedHashes = await this.stateManager.checkAndSetAccountData(
        wrappedDataListFiltered,
        `testAndPatchAccounts`,
        true,
        updatedAccounts
      )

      if (failedHashes.length != 0) {
        /* prettier-ignore */ nestedCountersInstance.countEvent('accountPatcher', 'checkAndSetAccountData failed hashes', failedHashes.length)
        this.statemanager_fatal(
          'isInSync = false, failed hashes',
          `isInSync = false cycle:${cycle}:  failed hashes:${failedHashes.length}`
        )
      }
      const appliedFixes = Math.max(0, wrappedDataListFiltered.length - failedHashes.length)
      /* prettier-ignore */ nestedCountersInstance.countEvent('accountPatcher', 'writeCombinedAccountDataToBackups', Math.max(0,wrappedDataListFiltered.length - failedHashes.length))
      /* prettier-ignore */ nestedCountersInstance.countEvent('accountPatcher', `p.repair applied c:${cycle} bad:${results.badAccounts.length} received:${wrappedDataList.length} failedH: ${failedHashes.length} filtered:${utils.stringifyReduce(filterStats)} stats:${utils.stringifyReduce(results.stats)} getAccountStats: ${utils.stringifyReduce(getAccountStats)} extraBadKeys:${results.extraBadKeys.length}`, appliedFixes)

      this.stateManager.cycleDebugNotes.patchedAccounts = appliedFixes //per cycle debug info

      let logLimit = 3000000
      if (logFlags.verbose === false) {
        logLimit = 2000
      }

      const repairedAccountSummary = utils.stringifyReduceLimit(
        wrappedDataListFiltered.map((account) => {
          return { a: account.accountId, h: account.stateId }
        }),
        logLimit
      )
      this.statemanager_fatal(
        'isInSync = false',
        `bad accounts cycle:${cycle} bad:${results.badAccounts.length} received:${
          wrappedDataList.length
        } failedH: ${failedHashes.length} filtered:${utils.stringifyReduce(
          filterStats
        )} stats:${utils.stringifyReduce(results.stats)} getAccountStats: ${utils.stringifyReduce(
          getAccountStats
        )} details: ${utils.stringifyReduceLimit(results.badAccounts, logLimit)}`
      )
      this.statemanager_fatal(
        'isInSync = false',
        `isInSync = false ${cycle}: fixed:${appliedFixes}  repaired: ${repairedAccountSummary}`
      )

      trieRepairDump.stats = {
        badAcc: results.badAccounts.length,
        received: wrappedDataList.length,
        filterStats,
        getAccountStats,
        findBadAccountStats: results.stats,
      }

      trieRepairDump.z_accountSummary = repairedAccountSummary
      //This extracts accounts that have failed hashes but I forgot writeCombinedAccountDataToBackups does that already
      //let failedHashesSet = new Set(failedHashes)
      // let wrappedDataUpdated = []
      // for(let wrappedData of wrappedDataListFiltered){
      //   if(failedHashesSet.has(wrappedData.accountId )){
      //     continue
      //   }
      //   wrappedDataUpdated.push(wrappedData)
      // }

      const combinedAccountStateData: Shardus.StateTableObject[] = []
      const updatedSet = new Set()
      for (const updated of updatedAccounts) {
        updatedSet.add(updated)
      }
      for (const wrappedData of wrappedDataListFiltered) {
        if (updatedSet.has(wrappedData.accountId)) {
          const stateTableData = stateTableDataMap.get(wrappedData.stateId)
          if (stateTableData != null) {
            combinedAccountStateData.push(stateTableData)
          }
        }
      }
      if (combinedAccountStateData.length > 0) {
        await this.stateManager.storage.addAccountStates(combinedAccountStateData)
        /* prettier-ignore */ nestedCountersInstance.countEvent('accountPatcher', `p.repair stateTable c:${cycle} acc:#${updatedAccounts.length} st#:${combinedAccountStateData.length} missed#${combinedAccountStateData.length-updatedAccounts.length}`, combinedAccountStateData.length)
      }

      if (wrappedDataListFiltered.length > 0) {
        await this.stateManager.writeCombinedAccountDataToBackups(wrappedDataListFiltered, failedHashes)
      }

      //apply repair account data and update shard trie

      // get list of accounts that were fixed. (should happen for free by account cache system)
      // for(let wrappedData of wrappedDataList){
      //   if(failedHashesSet.has(wrappedData.accountId) === false){

      //     //need good way to update trie..  just insert and let it happen next round!
      //     this.updateAccountHash(wrappedData.accountId, wrappedData.stateId)
      //   }
      // }
      //check again if we are in sync

      this.lastRepairInfo = trieRepairDump

      //update the repair count
      failHistoryObject.repaired += appliedFixes

      //This is something that can be checked with debug endpoints get-tree-last-insync-all / get-tree-last-insync
      this.failedLastTrieSync = true
    } else {
      nestedCountersInstance.countEvent(`accountPatcher`, `inSync`)

      if (lastFail === true) {
        const failHistoryObject = this.syncFailHistory[this.syncFailHistory.length - 1]
        this.failEndCycle = cycle
        failHistoryObject.e = this.failEndCycle
        failHistoryObject.cycles = this.failEndCycle - this.failStartCycle

        /* prettier-ignore */ nestedCountersInstance.countEvent(`accountPatcher`, `inSync again. ${JSON.stringify(this.syncFailHistory[this.syncFailHistory.length -1])}`)

        //this is not really a fatal log so should be removed eventually. is is somewhat usefull context though when debugging.
        this.statemanager_fatal(`inSync again`, JSON.stringify(this.syncFailHistory))
      }
    }
  }

  /**
   * simulateRepairs
   * incomplete.  the idea was to see if potential repairs can even solve our current sync issue.
   * not sure this is worth the perf/complexity/effort.
   *
   * if we miss something, the patcher can just try again next cycle.
   *
   * @param cycle
   * @param badAccounts
   */
  simulateRepairs(_cycle: number, badAccounts: AccountIDAndHash[]): AccountPreTest[] {
    const results = []

    for (const badAccount of badAccounts) {
      const preTestResult = {
        accountID: badAccount.accountID,
        hash: badAccount.hash,
        preTestStatus: 1 /*PreTestStatus.Valid*/,
      }
      results.push(preTestResult)

      //todo run test that can change the pretestStatus value!
    }
    return results
  }

  /***
   *     ######   ######## ########    ###     ######   ######   #######  ##     ## ##    ## ######## ########  ######## ########     ###    #### ########  ########     ###    ########    ###
   *    ##    ##  ##          ##      ## ##   ##    ## ##    ## ##     ## ##     ## ###   ##    ##    ##     ## ##       ##     ##   ## ##    ##  ##     ## ##     ##   ## ##      ##      ## ##
   *    ##        ##          ##     ##   ##  ##       ##       ##     ## ##     ## ####  ##    ##    ##     ## ##       ##     ##  ##   ##   ##  ##     ## ##     ##  ##   ##     ##     ##   ##
   *    ##   #### ######      ##    ##     ## ##       ##       ##     ## ##     ## ## ## ##    ##    ########  ######   ########  ##     ##  ##  ########  ##     ## ##     ##    ##    ##     ##
   *    ##    ##  ##          ##    ######### ##       ##       ##     ## ##     ## ##  ####    ##    ##   ##   ##       ##        #########  ##  ##   ##   ##     ## #########    ##    #########
   *    ##    ##  ##          ##    ##     ## ##    ## ##    ## ##     ## ##     ## ##   ###    ##    ##    ##  ##       ##        ##     ##  ##  ##    ##  ##     ## ##     ##    ##    ##     ##
   *     ######   ########    ##    ##     ##  ######   ######   #######   #######  ##    ##    ##    ##     ## ######## ##        ##     ## #### ##     ## ########  ##     ##    ##    ##     ##
   */
  //todo test the tree to see if repairs will work.   not simple to do efficiently
  //todo robust query the hashes?  technically if we repair to bad data it will just get detected and fixed again!!!

  /**
   * getAccountRepairData
   * take a list of bad accounts and figures out which nodes we can ask to get the data.
   * makes one or more data requests in parallel
   * organizes and returns the results.
   * @param cycle
   * @param badAccounts
   */
  async getAccountRepairData(
    cycle: number,
    badAccounts: AccountIDAndHash[]
  ): Promise<{
    wrappedDataList: Shardus.WrappedData[]
    stateTableDataMap: Map<string, Shardus.StateTableObject>
    getAccountStats: AccountStats
  }> {
    //pick which nodes to ask! /    //build up requests
    const nodesBySyncRadix: Map<
      string,
      { node: Shardus.Node; request: { cycle: number; accounts: AccountIDAndHash[] } }
    > = new Map()
    const accountHashMap = new Map()

    const wrappedDataList: Shardus.WrappedData[] = []
    const stateTableDataMap: Map<string, Shardus.StateTableObject> = new Map()

    const getAccountStats: AccountStats = {
      skipping: 0,
      multiRequests: 0,
      requested: 0,
      //alreadyOKHash:0
    }

    try {
      for (const accountEntry of badAccounts) {
        const syncRadix = accountEntry.accountID.substring(0, this.treeSyncDepth)
        let requestEntry = nodesBySyncRadix.get(syncRadix)

        // let accountMemData: AccountHashCache = this.stateManager.accountCache.getAccountHash(accountEntry.accountID)
        // if(accountMemData != null && accountMemData.h === accountEntry.hash){
        //   stats.alreadyOKHash++
        //   continue
        // }

        accountHashMap.set(accountEntry.accountID, accountEntry.hash)
        if (requestEntry == null) {
          //minor layer of security, we will ask a different node for the account than the one that gave us the hash
          const nodeToAsk = this.getNodeForQuery(accountEntry.accountID, cycle, true)
          if (nodeToAsk == null) {
            this.statemanager_fatal(
              'getAccountRepairData no node avail',
              `getAccountRepairData no node avail ${cycle}`
            )
            continue
          }
          requestEntry = { node: nodeToAsk, request: { cycle, accounts: [] } }
          nodesBySyncRadix.set(syncRadix, requestEntry)
        }
        requestEntry.request.accounts.push(accountEntry)
      }

      const promises = []
      const accountPerRequest = this.config.stateManager.patcherAccountsPerRequest
      const maxAskCount = this.config.stateManager.patcherAccountsPerUpdate
      for (const requestEntry of nodesBySyncRadix.values()) {
        if (requestEntry.request.accounts.length > accountPerRequest) {
          let offset = 0
          const allAccounts = requestEntry.request.accounts
          let thisAskCount = 0
          while (
            offset < allAccounts.length &&
            Math.min(offset + accountPerRequest, allAccounts.length) < maxAskCount
          ) {
            requestEntry.request.accounts = allAccounts.slice(offset, offset + accountPerRequest)
            const promise = this.p2p.ask(
              requestEntry.node,
              'get_account_data_by_hashes',
              requestEntry.request
            )
            promises.push(promise)
            offset = offset + accountPerRequest
            getAccountStats.multiRequests++
            thisAskCount = requestEntry.request.accounts.length
          }

          getAccountStats.skipping += Math.max(0, allAccounts.length - thisAskCount)
          getAccountStats.requested += thisAskCount

          //would it be better to resync if we have a high number of errors?  not easy to answer this.
        } else {
          const promise = this.p2p.ask(requestEntry.node, 'get_account_data_by_hashes', requestEntry.request)
          promises.push(promise)
          getAccountStats.requested = requestEntry.request.accounts.length
        }
      }

      const promiseResults = await Promise.allSettled(promises) //as HashTrieAccountDataResponse[]
      for (const promiseResult of promiseResults) {
        if (promiseResult.status === 'rejected') {
          continue
        }
        const result = promiseResult.value as HashTrieAccountDataResponse
        //HashTrieAccountDataResponse
        if (result != null && result.accounts != null && result.accounts.length > 0) {
          if (result.stateTableData != null && result.stateTableData.length > 0) {
            for (const stateTableData of result.stateTableData) {
              stateTableDataMap.set(stateTableData.stateAfter, stateTableData)
            }
          }

          //wrappedDataList = wrappedDataList.concat(result.accounts)
          for (const wrappedAccount of result.accounts) {
            const desiredHash = accountHashMap.get(wrappedAccount.accountId)
            if (desiredHash != wrappedAccount.stateId) {
              //got account back but has the wrong stateID
              //nestedCountersInstance.countEvent('accountPatcher', 'getAccountRepairData wrong hash')
              this.statemanager_fatal(
                'getAccountRepairData wrong hash',
                `getAccountRepairData wrong hash ${utils.stringifyReduce(wrappedAccount.accountId)}`
              )
              continue
            }
            wrappedDataList.push(wrappedAccount)

            // let stateDataFound = stateTableDataMap.get(wrappedAccount.accountId)
            // if(stateDataFound != null){
            //   //todo filtering
            //   if(stateDataFound.stateAfter === desiredHash){
            //     stateTableDataList.push(stateDataFound)
            //   }
            // }
          }
        }
      }
    } catch (error) {
      this.statemanager_fatal(
        'getAccountRepairData fatal ' + wrappedDataList.length,
        'getAccountRepairData fatal ' + wrappedDataList.length + ' ' + errorToStringFull(error)
      )
    }

    return { wrappedDataList, stateTableDataMap, getAccountStats }
  }

  /***
   *    ########  ########   #######   ######  ########  ######   ######   ######  ##     ##    ###    ########  ########  ########  ##     ## ##     ## ########
   *    ##     ## ##     ## ##     ## ##    ## ##       ##    ## ##    ## ##    ## ##     ##   ## ##   ##     ## ##     ## ##     ## ##     ## ###   ### ##     ##
   *    ##     ## ##     ## ##     ## ##       ##       ##       ##       ##       ##     ##  ##   ##  ##     ## ##     ## ##     ## ##     ## #### #### ##     ##
   *    ########  ########  ##     ## ##       ######    ######   ######   ######  ######### ##     ## ########  ##     ## ##     ## ##     ## ## ### ## ########
   *    ##        ##   ##   ##     ## ##       ##             ##       ##       ## ##     ## ######### ##   ##   ##     ## ##     ## ##     ## ##     ## ##
   *    ##        ##    ##  ##     ## ##    ## ##       ##    ## ##    ## ##    ## ##     ## ##     ## ##    ##  ##     ## ##     ## ##     ## ##     ## ##
   *    ##        ##     ##  #######   ######  ########  ######   ######   ######  ##     ## ##     ## ##     ## ########  ########   #######  ##     ## ##
   */

  /**
   * processShardDump
   * debug only code to create a shard report.
   * @param stream
   * @param lines
   */
  processShardDump(
    stream: Response<unknown, Record<string, unknown>, number>,
    lines: Line[]
  ): { allPassed: boolean; allPassed2: boolean } {
    const dataByParition = new Map()

    const rangesCovered = []
    const nodesListsCovered = []
    const nodeLists = []
    let newestCycle = -1
    const partitionObjects = []
    for (const line of lines) {
      const index = line.raw.indexOf('{"allNodeIds')
      if (index >= 0) {
        const partitionStr = line.raw.slice(index)
        //this.generalLog(string)
        let partitionObj: { cycle: number; owner: string }
        try {
          partitionObj = JSON.parse(partitionStr)
        } catch (error) {
          this.mainLogger.error('error parsing partitionObj', error, partitionStr)
          continue
        }

        if (newestCycle > 0 && partitionObj.cycle != newestCycle) {
          stream.write(
            `wrong cycle for node: ${line.file.owner} reportCycle:${newestCycle} thisNode:${partitionObj.cycle} \n`
          )
          continue
        }
        partitionObjects.push(partitionObj)

        if (partitionObj.cycle > newestCycle) {
          newestCycle = partitionObj.cycle
        }
        partitionObj.owner = line.file.owner //line.raw.slice(0, index)
      }
    }

    for (const partitionObj of partitionObjects) {
      // we only want data for nodes that were active in the latest cycle.
      if (partitionObj.cycle === newestCycle) {
        for (const partition of partitionObj.partitions) {
          let results = dataByParition.get(partition.parititionID)
          if (results == null) {
            results = []
            dataByParition.set(partition.parititionID, results)
          }
          results.push({
            owner: partitionObj.owner,
            accounts: partition.accounts,
            ownerId: partitionObj.rangesCovered.id,
            accounts2: partition.accounts2,
            partitionHash2: partition.partitionHash2,
          })
        }
        rangesCovered.push(partitionObj.rangesCovered)
        nodesListsCovered.push(partitionObj.nodesCovered)
        nodeLists.push(partitionObj.allNodeIds)
      }
    }

    // need to only count stuff from the newestCycle.

    // /////////////////////////////////////////////////
    // compare partition data: old system with data manual queried from app
    let allPassed = true
    // let uniqueVotesByPartition = new Array(numNodes).fill(0)
    for (const [key, value] of dataByParition) {
      const results = value
      const votes = {}
      for (const entry of results) {
        if (entry.accounts.length === 0) {
          // new settings allow for not using accounts from sql
          continue
        }
        entry.accounts.sort(function (a: { id: number }, b: { id: number }) {
          return a.id === b.id ? 0 : a.id < b.id ? -1 : 1
        })
        const string = utils.stringifyReduce(entry.accounts)
        let voteEntry = votes[string] // eslint-disable-line security/detect-object-injection
        if (voteEntry == null) {
          voteEntry = {}
          voteEntry.voteCount = 0
          voteEntry.ownerIds = []
          votes[string] = voteEntry // eslint-disable-line security/detect-object-injection
        }
        voteEntry.voteCount++
        votes[string] = voteEntry // eslint-disable-line security/detect-object-injection

        voteEntry.ownerIds.push(entry.ownerId)
      }
      for (const key2 of Object.keys(votes)) {
        const voteEntry = votes[key2] // eslint-disable-line security/detect-object-injection
        let voters = ''
        if (key2 !== '[]') {
          voters = `---voters:${JSON.stringify(voteEntry.ownerIds)}`
        }

        stream.write(`partition: ${key}  votes: ${voteEntry.voteCount} values: ${key2} \t\t\t${voters}\n`)
        // stream.write(`            ---voters: ${JSON.stringify(voteEntry.ownerIds)}\n`)
      }
      const numUniqueVotes = Object.keys(votes).length
      if (numUniqueVotes > 2 || (numUniqueVotes > 1 && votes['[]'] == null)) {
        allPassed = false
        stream.write(`partition: ${key} failed.  Too many different version of data: ${numUniqueVotes} \n`)
      }
    }
    stream.write(`partition tests all passed: ${allPassed}\n`)
    // rangesCovered

    // /////////////////////////////////////////////////
    // compare partition data 2: new system using the state manager cache
    let allPassed2 = true
    // let uniqueVotesByPartition = new Array(numNodes).fill(0)
    for (const [key, value] of dataByParition) {
      const results = value
      const votes = {}
      for (const entry of results) {
        // no account sort, we expect this to have a time sort!
        // entry.accounts.sort(function (a, b) { return a.id === b.id ? 0 : a.id < b.id ? -1 : 1 })
        const fullString = utils.stringifyReduce(entry.accounts2)
        let string = entry.partitionHash2
        if (string === undefined) {
          string = '[]'
        }

        let voteEntry = votes[string] // eslint-disable-line security/detect-object-injection
        if (voteEntry == null) {
          voteEntry = {}
          voteEntry.voteCount = 0
          voteEntry.ownerIds = []
          voteEntry.fullString = fullString
          votes[string] = voteEntry // eslint-disable-line security/detect-object-injection
        }
        voteEntry.voteCount++
        votes[string] = voteEntry // eslint-disable-line security/detect-object-injection

        voteEntry.ownerIds.push(entry.ownerId)
      }
      for (const key2 of Object.keys(votes)) {
        const voteEntry = votes[key2] // eslint-disable-line security/detect-object-injection
        let voters = ''
        if (key2 !== '[]') {
          voters = `---voters:${JSON.stringify(voteEntry.ownerIds)}`
        }

        stream.write(
          `partition: ${key}  votes: ${voteEntry.voteCount} values: ${key2} \t\t\t${voters}\t -details:${voteEntry.fullString}   \n`
        )
        // stream.write(`            ---voters: ${JSON.stringify(voteEntry.ownerIds)}\n`)
      }
      const numUniqueVotes = Object.keys(votes).length
      if (numUniqueVotes > 2 || (numUniqueVotes > 1 && votes['[]'] == null)) {
        allPassed2 = false
        stream.write(`partition: ${key} failed.  Too many different version of data: ${numUniqueVotes} \n`)
      }
    }

    stream.write(`partition tests all passed: ${allPassed2}\n`)

    rangesCovered.sort(function (a, b) {
      return a.id === b.id ? 0 : a.id < b.id ? -1 : 1
    })

    const isStored = function (i: number, rangeCovered: { stMin: number; stMax: number }): boolean {
      const key = i
      const minP = rangeCovered.stMin
      const maxP = rangeCovered.stMax
      if (minP === maxP) {
        if (i !== minP) {
          return false
        }
      } else if (maxP > minP) {
        // are we outside the min to max range
        if (key < minP || key > maxP) {
          return false
        }
      } else {
        // are we inside the min to max range (since the covered rage is inverted)
        if (key > maxP && key < minP) {
          return false
        }
      }
      return true
    }
    const isConsensus = function (i: number, rangeCovered: { cMin: number; cMax: number }): boolean {
      const key = i
      const minP = rangeCovered.cMin
      const maxP = rangeCovered.cMax
      if (minP === maxP) {
        if (i !== minP) {
          return false
        }
      } else if (maxP > minP) {
        // are we outside the min to max range
        if (key < minP || key > maxP) {
          return false
        }
      } else {
        // are we inside the min to max range (since the covered rage is inverted)
        if (key > maxP && key < minP) {
          return false
        }
      }
      return true
    }

    for (const range of rangesCovered) {
      let partitionGraph = ''
      for (let i = 0; i < range.numP; i++) {
        const isC = isConsensus(i, range)
        const isSt = isStored(i, range)

        if (i === range.hP) {
          partitionGraph += 'H'
        } else if (isC && isSt) {
          partitionGraph += 'C'
        } else if (isC) {
          partitionGraph += '!'
        } else if (isSt) {
          partitionGraph += 'e'
        } else {
          partitionGraph += '_'
        }
      }

      stream.write(
        `node: ${range.id} ${range.ipPort}\tgraph: ${partitionGraph}\thome: ${
          range.hP
        }   data:${JSON.stringify(range)}\n`
      )
    }
    stream.write(`\n\n`)
    nodesListsCovered.sort(function (a, b) {
      return a.id === b.id ? 0 : a.id < b.id ? -1 : 1
    })
    for (const nodesCovered of nodesListsCovered) {
      let partitionGraph = ''
      const consensusMap = {}
      const storedMap = {}
      for (const entry of nodesCovered.consensus) {
        consensusMap[entry.idx] = { hp: entry.hp }
      }
      for (const entry of nodesCovered.stored) {
        storedMap[entry.idx] = { hp: entry.hp }
      }

      for (let i = 0; i < nodesCovered.numP; i++) {
        const isC = consensusMap[i] != null // eslint-disable-line security/detect-object-injection
        const isSt = storedMap[i] != null // eslint-disable-line security/detect-object-injection
        if (i === nodesCovered.idx) {
          partitionGraph += 'O'
        } else if (isC && isSt) {
          partitionGraph += 'C'
        } else if (isC) {
          partitionGraph += '!'
        } else if (isSt) {
          partitionGraph += 'e'
        } else {
          partitionGraph += '_'
        }
      }

      stream.write(
        `node: ${nodesCovered.id} ${nodesCovered.ipPort}\tgraph: ${partitionGraph}\thome: ${
          nodesCovered.hP
        } data:${JSON.stringify(nodesCovered)}\n`
      )
    }
    stream.write(`\n\n`)
    for (const list of nodeLists) {
      stream.write(`${JSON.stringify(list)} \n`)
    }

    return { allPassed, allPassed2 }
  }

  calculateMinVotes(): number {
    let minVotes = Math.ceil(
      this.stateManager.currentCycleShardData.shardGlobals.nodesPerConsenusGroup * 0.51
    )
    const majorityOfActiveNodes = Math.ceil(this.stateManager.currentCycleShardData.nodes.length * 0.51)
    minVotes = Math.min(minVotes, majorityOfActiveNodes)
    minVotes = Math.max(1, minVotes)
    return minVotes
  }
}

type BadAccountStats = {
  testedSyncRadix: number
  skippedSyncRadix: number
  badSyncRadix: number
  ok_noTrieAcc: number
  ok_trieHashBad: number
  fix_butHashMatch: number
  fixLastSeen: number
  needsVotes: number
  subHashesTested: number
  trailColdLevel: number
  checkedLevel: number
  leafsChecked: number
  leafResponses: number
  getAccountHashStats: Record<string, never>
}

type BadAccountsInfo = {
  badAccounts: AccountIDAndHash[]
  hashesPerLevel: number[]
  checkedKeysPerLevel: number[]
  requestedKeysPerLevel: number[]
  badHashesPerLevel: number[]
  accountHashesChecked: number
  stats: BadAccountStats
  extraBadKeys: string[]
}

export default AccountPatcher
