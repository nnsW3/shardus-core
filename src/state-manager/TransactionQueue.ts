import { ShardusConfiguration } from '../shardus/shardus-types'
import Shardus = require('../shardus/shardus-types')
import { ShardGlobals, ShardInfo, StoredPartition, NodeShardData, AddressRange, HomeNodeSummary, ParititionShardDataMap, NodeShardDataMap, MergeResults, BasicAddressRange } from './shardFunctionTypes'
import * as utils from '../utils'
const stringify = require('fast-stable-stringify')

import Profiler from '../utils/profiler'
import { P2PModuleContext as P2P } from '../p2p/Context'
import Storage from '../storage'
import Crypto from '../crypto'
import Logger from '../logger'
import ShardFunctions from './shardFunctions.js'
import { time } from 'console'
import StateManager from '.'

const http = require('../http')
const allZeroes64 = '0'.repeat(64)

class TransactionQueue {
  app: Shardus.App
  crypto: Crypto
  config: Shardus.ShardusConfiguration
  profiler: Profiler
  verboseLogs: boolean
  logger: Logger
  p2p: P2P
  storage: Storage
  stateManager: StateManager

  mainLogger: any
  fatalLogger: any
  shardLogger: any
  statsLogger: any
  statemanager_fatal: (key: string, log: string) => void

  applySoftLock: boolean

  newAcceptedTxQueue: QueueEntry[]
  newAcceptedTxQueueTempInjest: QueueEntry[]
  archivedQueueEntries: QueueEntry[]

  queueStopped: boolean
  queueEntryCounter: number
  queueRestartCounter: number

  archivedQueueEntryMaxCount: number
  newAcceptedTxQueueRunning: boolean //archivedQueueEntryMaxCount is a maximum amount of queue entries to store, usually we should never have this many stored since tx age will be used to clean up the list

  constructor(stateManager: StateManager, verboseLogs: boolean, profiler: Profiler, app: Shardus.App, logger: Logger, storage: Storage, p2p: P2P, crypto: Crypto, config: Shardus.ShardusConfiguration) {
    this.verboseLogs = verboseLogs
    this.crypto = crypto
    this.app = app
    this.logger = logger
    this.config = config
    this.profiler = profiler
    this.p2p = p2p
    this.storage = storage
    this.stateManager = stateManager

    this.mainLogger = logger.getLogger('main')
    this.fatalLogger = logger.getLogger('fatal')
    this.shardLogger = logger.getLogger('shardDump')
    this.statsLogger = logger.getLogger('statsDump')
    this.statemanager_fatal = stateManager.statemanager_fatal

    this.applySoftLock = false
    this.queueStopped = false
    this.queueEntryCounter = 0
    this.queueRestartCounter = 0

    this.newAcceptedTxQueue = []
    this.newAcceptedTxQueueTempInjest = []
    this.archivedQueueEntries = []

    this.archivedQueueEntryMaxCount = 50000
    this.newAcceptedTxQueueRunning = false
  }

  setupHandlers() {
    // p2p TELL
    this.p2p.registerInternal('broadcast_state', async (payload: { txid: string; stateList: any[] }, respond: any) => {
      // Save the wrappedAccountState with the rest our queue data
      // let message = { stateList: datas, txid: queueEntry.acceptedTX.id }
      // this.p2p.tell([correspondingEdgeNode], 'broadcast_state', message)

      // make sure we have it
      let queueEntry = this.getQueueEntrySafe(payload.txid) // , payload.timestamp)
      if (queueEntry == null) {
        //if we are syncing we need to queue this transaction!

        //this.transactionQueue.routeAndQueueAcceptedTransaction (acceptedTx:AcceptedTx, sendGossip:boolean = true, sender: Shardus.Node  |  null, globalModification:boolean)

        return
      }
      // add the data in
      for (let data of payload.stateList) {
        this.queueEntryAddData(queueEntry, data)
        if (queueEntry.state === 'syncing') {
          if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_sync_gotBroadcastData', `${queueEntry.acceptedTx.id}`, ` qId: ${queueEntry.entryID} data:${data.accountId}`)
        }
      }
    })

    this.p2p.registerGossipHandler('spread_tx_to_group', async (payload, sender, tracker) => {
      //  gossip 'spread_tx_to_group' to transaction group
      // Place tx in queue (if younger than m)

      let queueEntry = this.getQueueEntrySafe(payload.id) // , payload.timestamp)
      if (queueEntry) {
        return
        // already have this in our queue
      }

      //TODO need to check transaction fields.

      let noConsensus = false // this can only be true for a set command which will never come from an endpoint
      let added = this.routeAndQueueAcceptedTransaction(payload, /*sendGossip*/ false, sender, /*globalModification*/ false, noConsensus)
      if (added === 'lost') {
        return // we are faking that the message got lost so bail here
      }
      if (added === 'out of range') {
        return
      }
      if (added === 'notReady') {
        return
      }
      queueEntry = this.getQueueEntrySafe(payload.id) //, payload.timestamp) // now that we added it to the queue, it should be possible to get the queueEntry now

      if (queueEntry == null) {
        // do not gossip this, we are not involved
        this.statemanager_fatal(`spread_tx_to_group_noQE`, `spread_tx_to_group failed: cant find queueEntry for:  ${utils.makeShortHash(payload.id)}`)
        return
      }

      //Validation.
      const initValidationResp = this.app.validateTxnFields(queueEntry.acceptedTx.data)
      if (initValidationResp.success !== true) {
        this.statemanager_fatal(`spread_tx_to_group_validateTX`, `spread_tx_to_group validateTxnFields failed: ${utils.stringifyReduce(initValidationResp)}`)
        return
      }

      //TODO check time before inserting queueEntry.  1sec future 5 second past max
      let timeM = this.stateManager.queueSitTime
      let timestamp = queueEntry.txKeys.timestamp
      let age = Date.now() - timestamp
      if (age > timeM * 0.9) {
        this.statemanager_fatal(`spread_tx_to_group_OldTx`, 'spread_tx_to_group cannot accept tx older than 0.9M ' + timestamp + ' age: ' + age)
        if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_spread_tx_to_groupToOld', '', 'spread_tx_to_group working on older tx ' + timestamp + ' age: ' + age)
        return
      }
      if (age < -1000) {
        this.statemanager_fatal(`spread_tx_to_group_tooFuture`, 'spread_tx_to_group cannot accept tx more than 1 second in future ' + timestamp + ' age: ' + age)
        if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_spread_tx_to_groupToFutrue', '', 'spread_tx_to_group tx too far in future' + timestamp + ' age: ' + age)
        return
      }

      // how did this work before??
      // get transaction group. 3 accounds, merge lists.
      let transactionGroup = this.queueEntryGetTransactionGroup(queueEntry)
      if (queueEntry.ourNodeInTransactionGroup === false) {
        return
      }
      if (transactionGroup.length > 1) {
        this.stateManager.debugNodeGroup(queueEntry.acceptedTx.id, queueEntry.acceptedTx.timestamp, `gossip to neighbors`, transactionGroup)
        this.p2p.sendGossipIn('spread_tx_to_group', payload, tracker, sender, transactionGroup)
      }

      // await this.transactionQueue.routeAndQueueAcceptedTransaction(acceptedTX, false, sender)
    })

    /**
     * request_state_for_tx
     * used by the transaction queue when a queue entry needs to ask for missing state
     */
    this.p2p.registerInternal('request_state_for_tx', async (payload: RequestStateForTxReq, respond: (arg0: RequestStateForTxResp) => any) => {
      let response: RequestStateForTxResp = { stateList: [], beforeHashes: {}, note: '', success: false }
      // app.getRelevantData(accountId, tx) -> wrappedAccountState  for local accounts
      let queueEntry = this.getQueueEntrySafe(payload.txid) // , payload.timestamp)
      if (queueEntry == null) {
        queueEntry = this.getQueueEntryArchived(payload.txid, 'request_state_for_tx') // , payload.timestamp)
      }

      if (queueEntry == null) {
        response.note = `failed to find queue entry: ${utils.stringifyReduce(payload.txid)}  ${payload.timestamp} dbg:${this.stateManager.debugTXHistory[utils.stringifyReduce(payload.txid)]}`
        await respond(response)
        // TODO ???? if we dont have a queue entry should we do db queries to get the needed data?
        // my guess is probably not yet
        return
      }

      for (let key of payload.keys) {
        let data = queueEntry.originalData[key] // collectedData
        if (data) {
          response.stateList.push(JSON.parse(data))
        }
      }
      response.success = true
      await respond(response)
    })
  }

  /***
   *       ###    ########  ########   ######  ########    ###    ######## ########
   *      ## ##   ##     ## ##     ## ##    ##    ##      ## ##      ##    ##
   *     ##   ##  ##     ## ##     ## ##          ##     ##   ##     ##    ##
   *    ##     ## ########  ########   ######     ##    ##     ##    ##    ######
   *    ######### ##        ##              ##    ##    #########    ##    ##
   *    ##     ## ##        ##        ##    ##    ##    ##     ##    ##    ##
   *    ##     ## ##        ##         ######     ##    ##     ##    ##    ########
   */

  /* -------- APPSTATE Functions ---------- */

  async getAccountsStateHash(accountStart = '0'.repeat(64), accountEnd = 'f'.repeat(64), tsStart = 0, tsEnd = Date.now()) {
    const accountStates = await this.storage.queryAccountStateTable(accountStart, accountEnd, tsStart, tsEnd, 100000000)
    const stateHash = this.crypto.hash(accountStates)
    return stateHash
  }

  async testAccountTimesAndStateTable2(tx: Shardus.OpaqueTransaction, wrappedStates: WrappedStates) {
    let hasStateTableData = false

    function tryGetAccountData(accountID: string) {
      return wrappedStates[accountID]
    }

    try {
      let keysResponse = this.app.getKeyFromTransaction(tx)
      let { sourceKeys, targetKeys, timestamp } = keysResponse
      let sourceAddress, sourceState, targetState

      // check account age to make sure it is older than the tx
      let failedAgeCheck = false

      let accountKeys = Object.keys(wrappedStates)
      for (let key of accountKeys) {
        let accountEntry = tryGetAccountData(key)
        if (accountEntry.timestamp >= timestamp) {
          failedAgeCheck = true
          if (this.verboseLogs) this.mainLogger.debug('testAccountTimesAndStateTable account has future state.  id: ' + utils.makeShortHash(accountEntry.accountId) + ' time: ' + accountEntry.timestamp + ' txTime: ' + timestamp + ' delta: ' + (timestamp - accountEntry.timestamp))
        }
      }
      if (failedAgeCheck) {
        // if (this.verboseLogs) this.mainLogger.debug('DATASYNC: testAccountTimesAndStateTable accounts have future state ' + timestamp)
        return { success: false, hasStateTableData }
      }

      // check state table
      if (Array.isArray(sourceKeys) && sourceKeys.length > 0) {
        sourceAddress = sourceKeys[0]
        let accountStates = await this.storage.searchAccountStateTable(sourceAddress, timestamp)
        if (accountStates.length !== 0) {
          let accountEntry = tryGetAccountData(sourceAddress)
          if (accountEntry == null) {
            return { success: false, hasStateTableData }
          }
          sourceState = accountEntry.stateId
          hasStateTableData = true
          if (accountStates.length === 0 || accountStates[0].stateBefore !== sourceState) {
            if (accountStates[0].stateBefore === '0'.repeat(64)) {
              //sorta broken security hole.
              if (this.verboseLogs) this.mainLogger.debug('testAccountTimesAndStateTable ' + timestamp + 'bypass state comparision if before state was 00000: ' + utils.makeShortHash(sourceState) + ' stateTable: ' + utils.makeShortHash(accountStates[0].stateBefore) + ' address: ' + utils.makeShortHash(sourceAddress))
            } else {
              if (this.verboseLogs) console.log('testAccountTimesAndStateTable ' + timestamp + ' cant apply state 1')
              if (this.verboseLogs) this.mainLogger.debug('testAccountTimesAndStateTable ' + timestamp + ' cant apply state 1 stateId: ' + utils.makeShortHash(sourceState) + ' stateTable: ' + utils.makeShortHash(accountStates[0].stateBefore) + ' address: ' + utils.makeShortHash(sourceAddress))
              return { success: false, hasStateTableData }
            }
          }
        }
      }
      if (Array.isArray(targetKeys) && targetKeys.length > 0) {
        // targetAddress = targetKeys[0]
        for (let targetAddress of targetKeys) {
          let accountStates = await this.storage.searchAccountStateTable(targetAddress, timestamp)

          if (accountStates.length !== 0) {
            hasStateTableData = true
            if (accountStates.length !== 0 && accountStates[0].stateBefore !== allZeroes64) {
              let accountEntry = tryGetAccountData(targetAddress)

              if (accountEntry == null) {
                if (this.verboseLogs) console.log('testAccountTimesAndStateTable ' + timestamp + ' target state does not exist. address: ' + utils.makeShortHash(targetAddress))
                if (this.verboseLogs) this.mainLogger.debug('testAccountTimesAndStateTable ' + timestamp + ' target state does not exist. address: ' + utils.makeShortHash(targetAddress) + ' accountDataList: ')
                this.statemanager_fatal(`testAccountTimesAndStateTable_noEntry`, 'testAccountTimesAndStateTable ' + timestamp + ' target state does not exist. address: ' + utils.makeShortHash(targetAddress) + ' accountDataList: ') // todo: consider if this is just an error
                // fail this because we already check if the before state was all zeroes
                return { success: false, hasStateTableData }
              } else {
                targetState = accountEntry.stateId
                if (accountStates[0].stateBefore !== targetState) {
                  if (this.verboseLogs) console.log('testAccountTimesAndStateTable ' + timestamp + ' cant apply state 2')
                  if (this.verboseLogs) this.mainLogger.debug('testAccountTimesAndStateTable ' + timestamp + ' cant apply state 2 stateId: ' + utils.makeShortHash(targetState) + ' stateTable: ' + utils.makeShortHash(accountStates[0].stateBefore) + ' address: ' + utils.makeShortHash(targetAddress))
                  return { success: false, hasStateTableData }
                }
              }
            }
          }
        }
      }
    } catch (ex) {
      this.statemanager_fatal(`testAccountTimesAndStateTable_ex`, 'testAccountTimesAndStateTable failed: ' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
    }
    return { success: true, hasStateTableData }
  }

  /**
   * tryPreApplyTransaction this will try to apply a transaction but will not commit the data
   * @param acceptedTX
   * @param hasStateTableData
   * @param repairing
   * @param filter
   * @param wrappedStates
   * @param localCachedData
   */
  async tryPreApplyTransaction(acceptedTX: AcceptedTx, hasStateTableData: boolean, repairing: boolean, filter: AccountFilter, wrappedStates: WrappedResponses, localCachedData: LocalCachedData): Promise<{ passed: boolean; applyResult: string; applyResponse?: Shardus.ApplyResponse }> {
    let ourLockID = -1
    let accountDataList
    let txTs = 0
    let accountKeys = []
    let ourAccountLocks = null
    let applyResponse: Shardus.ApplyResponse | null = null
    //have to figure out if this is a global modifying tx, since that impacts if we will write to global account.
    let isGlobalModifyingTX = false

    try {
      let tx = acceptedTX.data
      // let receipt = acceptedTX.receipt
      let keysResponse = this.app.getKeyFromTransaction(tx)
      let { timestamp, debugInfo } = keysResponse
      txTs = timestamp

      let queueEntry = this.getQueueEntry(acceptedTX.id)
      if (queueEntry != null) {
        if (queueEntry.globalModification === true) {
          isGlobalModifyingTX = true
        }
      }

      if (this.verboseLogs) this.mainLogger.debug(`tryPreApplyTransaction  ts:${timestamp} repairing:${repairing} hasStateTableData:${hasStateTableData} isGlobalModifyingTX:${isGlobalModifyingTX}  Applying! debugInfo: ${debugInfo}`)
      if (this.verboseLogs) this.mainLogger.debug(`tryPreApplyTransaction  filter: ${utils.stringifyReduce(filter)}`)
      if (this.verboseLogs) this.mainLogger.debug(`tryPreApplyTransaction  acceptedTX: ${utils.stringifyReduce(acceptedTX)}`)
      if (this.verboseLogs) this.mainLogger.debug(`tryPreApplyTransaction  wrappedStates: ${utils.stringifyReduce(wrappedStates)}`)
      if (this.verboseLogs) this.mainLogger.debug(`tryPreApplyTransaction  localCachedData: ${utils.stringifyReduce(localCachedData)}`)

      if (repairing !== true) {
        // get a list of modified account keys that we will lock
        let { sourceKeys, targetKeys } = keysResponse
        for (let accountID of sourceKeys) {
          accountKeys.push(accountID)
        }
        for (let accountID of targetKeys) {
          accountKeys.push(accountID)
        }
        if (this.verboseLogs && this.stateManager.extendedRepairLogging) this.mainLogger.debug(` tryPreApplyTransaction FIFO lock outer: ${utils.stringifyReduce(accountKeys)} `)
        ourAccountLocks = await this.stateManager.bulkFifoLockAccounts(accountKeys)
        if (this.verboseLogs && this.stateManager.extendedRepairLogging) this.mainLogger.debug(` tryPreApplyTransaction FIFO lock inner: ${utils.stringifyReduce(accountKeys)} ourLocks: ${utils.stringifyReduce(ourAccountLocks)}`)
      }

      ourLockID = await this.stateManager.fifoLock('accountModification')

      if (this.verboseLogs) console.log(`tryPreApplyTransaction  ts:${timestamp} repairing:${repairing}  Applying!`)
      this.applySoftLock = true

      applyResponse = this.app.apply(tx as Shardus.IncomingTransaction, wrappedStates)
      let { stateTableResults, accountData: _accountdata } = applyResponse
      accountDataList = _accountdata

      if (this.verboseLogs) this.mainLogger.debug(`tryPreApplyTransaction  post apply wrappedStates: ${utils.stringifyReduce(wrappedStates)}`)

      this.applySoftLock = false
    } catch (ex) {
      this.mainLogger.error(`tryPreApplyTransaction failed id:${utils.makeShortHash(acceptedTX.id)}: ` + ex.name + ': ' + ex.message + ' at ' + ex.stack)
      this.mainLogger.error(`tryPreApplyTransaction failed id:${utils.makeShortHash(acceptedTX.id)}  ${utils.stringifyReduce(acceptedTX)}`)

      return { passed: false, applyResponse, applyResult: ex.message }
    } finally {
      this.stateManager.fifoUnlock('accountModification', ourLockID)
      if (repairing !== true) {
        if (ourAccountLocks != null) {
          this.stateManager.bulkFifoUnlockAccounts(accountKeys, ourAccountLocks)
        }
        if (this.verboseLogs) this.mainLogger.debug(` tryPreApplyTransaction FIFO unlock inner: ${utils.stringifyReduce(accountKeys)} ourLocks: ${utils.stringifyReduce(ourAccountLocks)}`)
      }
    }

    return { passed: true, applyResponse, applyResult: 'applied' }
  }

  async commitConsensedTransaction(applyResponse: Shardus.ApplyResponse, acceptedTX: AcceptedTx, hasStateTableData: boolean, repairing: boolean, filter: AccountFilter, wrappedStates: WrappedResponses, localCachedData: LocalCachedData): Promise<CommitConsensedTransactionResult> {
    let ourLockID = -1
    let accountDataList
    let txTs = 0
    let accountKeys = []
    let ourAccountLocks = null

    //have to figure out if this is a global modifying tx, since that impacts if we will write to global account.
    let isGlobalModifyingTX = false
    let savedSomething = false
    try {
      let tx = acceptedTX.data
      // let receipt = acceptedTX.receipt
      let keysResponse = this.app.getKeyFromTransaction(tx)
      let { timestamp, debugInfo } = keysResponse
      txTs = timestamp

      let queueEntry = this.getQueueEntry(acceptedTX.id)
      if (queueEntry != null) {
        if (queueEntry.globalModification === true) {
          isGlobalModifyingTX = true
        }
      }

      if (this.verboseLogs) this.mainLogger.debug(`commitConsensedTransaction  ts:${timestamp} repairing:${repairing} hasStateTableData:${hasStateTableData} isGlobalModifyingTX:${isGlobalModifyingTX}  Applying! debugInfo: ${debugInfo}`)
      if (this.verboseLogs) this.mainLogger.debug(`commitConsensedTransaction  filter: ${utils.stringifyReduce(filter)}`)
      if (this.verboseLogs) this.mainLogger.debug(`commitConsensedTransaction  acceptedTX: ${utils.stringifyReduce(acceptedTX)}`)
      if (this.verboseLogs) this.mainLogger.debug(`commitConsensedTransaction  wrappedStates: ${utils.stringifyReduce(wrappedStates)}`)
      if (this.verboseLogs) this.mainLogger.debug(`commitConsensedTransaction  localCachedData: ${utils.stringifyReduce(localCachedData)}`)

      if (repairing !== true) {
        // get a list of modified account keys that we will lock
        let { sourceKeys, targetKeys } = keysResponse
        for (let accountID of sourceKeys) {
          accountKeys.push(accountID)
        }
        for (let accountID of targetKeys) {
          accountKeys.push(accountID)
        }
        if (this.verboseLogs && this.stateManager.extendedRepairLogging) this.mainLogger.debug(`commitConsensedTransaction FIFO lock outer: ${utils.stringifyReduce(accountKeys)} `)
        ourAccountLocks = await this.stateManager.bulkFifoLockAccounts(accountKeys)
        if (this.verboseLogs && this.stateManager.extendedRepairLogging) this.mainLogger.debug(`commitConsensedTransaction FIFO lock inner: ${utils.stringifyReduce(accountKeys)} ourLocks: ${utils.stringifyReduce(ourAccountLocks)}`)
      }

      ourLockID = await this.stateManager.fifoLock('accountModification')

      if (this.verboseLogs) console.log(`commitConsensedTransaction  ts:${timestamp} repairing:${repairing}  Applying!`)
      // if (this.verboseLogs) this.mainLogger.debug('APPSTATE: tryApplyTransaction ' + timestamp + ' Applying!' + ' source: ' + utils.makeShortHash(sourceAddress) + ' target: ' + utils.makeShortHash(targetAddress) + ' srchash_before:' + utils.makeShortHash(sourceState) + ' tgtHash_before: ' + utils.makeShortHash(targetState))
      this.applySoftLock = true

      let { stateTableResults, accountData: _accountdata } = applyResponse
      accountDataList = _accountdata

      if (this.verboseLogs) this.mainLogger.debug(`commitConsensedTransaction  post apply wrappedStates: ${utils.stringifyReduce(wrappedStates)}`)
      // wrappedStates are side effected for now
      savedSomething = await this.stateManager.setAccount(wrappedStates, localCachedData, applyResponse, isGlobalModifyingTX, filter)

      if (this.verboseLogs) this.mainLogger.debug(`commitConsensedTransaction  savedSomething: ${savedSomething}`)
      if (this.verboseLogs) this.mainLogger.debug(`commitConsensedTransaction  accountData[${accountDataList.length}]: ${utils.stringifyReduce(accountDataList)}`)
      if (this.verboseLogs) this.mainLogger.debug(`commitConsensedTransaction  stateTableResults[${stateTableResults.length}]: ${utils.stringifyReduce(stateTableResults)}`)

      this.applySoftLock = false
      // only write our state table data if we dont already have it in the db
      if (hasStateTableData === false) {
        for (let stateT of stateTableResults) {
          // we have to correct this because it now gets stomped in the vote
          let wrappedRespose = wrappedStates[stateT.accountId]
          stateT.stateBefore = wrappedRespose.prevStateId

          if (this.verboseLogs) console.log('writeStateTable ' + utils.makeShortHash(stateT.accountId) + ' accounts total' + accountDataList.length)
          if (this.verboseLogs) this.mainLogger.debug('writeStateTable ' + utils.makeShortHash(stateT.accountId) + ' before: ' + utils.makeShortHash(stateT.stateBefore) + ' after: ' + utils.makeShortHash(stateT.stateAfter) + ' txid: ' + utils.makeShortHash(acceptedTX.id) + ' ts: ' + acceptedTX.timestamp)
        }
        await this.storage.addAccountStates(stateTableResults)
      }

      // post validate that state ended up correctly?

      // write the accepted TX to storage
      this.storage.addAcceptedTransactions([acceptedTX])

      // endpoint to allow dapp to execute something that depends on a transaction being approved.
      this.app.transactionReceiptPass(acceptedTX.data, wrappedStates, applyResponse)
    } catch (ex) {
      this.statemanager_fatal(`commitConsensedTransaction_ex`, 'commitConsensedTransaction failed: ' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
      this.mainLogger.debug(`commitConsensedTransaction failed id:${utils.makeShortHash(acceptedTX.id)}  ${utils.stringifyReduce(acceptedTX)}`)
      if (applyResponse) {
        // && savedSomething){
        // TSConversion do we really want to record this?
        // if (!repairing) this.stateManager.partitionObjects.tempRecordTXByCycle(txTs, acceptedTX, false, applyResponse, isGlobalModifyingTX, savedSomething)
        // record no-op state table fail:
      } else {
        // this.fatalLogger.fatal('tryApplyTransaction failed: applyResponse == null')
      }

      return { success: false }
    } finally {
      this.stateManager.fifoUnlock('accountModification', ourLockID)
      if (repairing !== true) {
        if (ourAccountLocks != null) {
          this.stateManager.bulkFifoUnlockAccounts(accountKeys, ourAccountLocks)
        }
        if (this.verboseLogs) this.mainLogger.debug(`commitConsensedTransaction FIFO unlock inner: ${utils.stringifyReduce(accountKeys)} ourLocks: ${utils.stringifyReduce(ourAccountLocks)}`)
      }
    }

    // have to wrestle with the data a bit so we can backup the full account and not jsut the partial account!
    // let dataResultsByKey = {}
    let dataResultsFullList = []
    for (let wrappedData of applyResponse.accountData) {
      // if (wrappedData.isPartial === false) {
      //   dataResultsFullList.push(wrappedData.data)
      // } else {
      //   dataResultsFullList.push(wrappedData.localCache)
      // }
      if (wrappedData.localCache != null) {
        dataResultsFullList.push(wrappedData)
      }
      // dataResultsByKey[wrappedData.accountId] = wrappedData.data
    }

    // this is just for debug!!!
    if (dataResultsFullList[0] == null) {
      for (let wrappedData of applyResponse.accountData) {
        if (wrappedData.localCache != null) {
          dataResultsFullList.push(wrappedData)
        }
        // dataResultsByKey[wrappedData.accountId] = wrappedData.data
      }
    }
    // if(dataResultsFullList == null){
    //   throw new Error(`tryApplyTransaction (dataResultsFullList == null  ${txTs} ${utils.stringifyReduce(acceptedTX)} `);
    // }

    // TSConversion verified that app.setAccount calls shardus.applyResponseAddState  that adds hash and txid to the data and turns it into AccountData
    let upgradedAccountDataList: Shardus.AccountData[] = (dataResultsFullList as unknown) as Shardus.AccountData[]

    await this.stateManager.updateAccountsCopyTable(upgradedAccountDataList, repairing, txTs)

    if (!repairing) {
      //if(savedSomething){
      //this.stateManager.partitionObjects.tempRecordTXByCycle(txTs, acceptedTX, true, applyResponse, isGlobalModifyingTX, savedSomething)
      //}

      //WOW this was not good!  had acceptedTX.transactionGroup[0].id
      //if (this.p2p.getNodeId() === acceptedTX.transactionGroup[0].id) {

      let queueEntry: QueueEntry | null = this.getQueueEntry(acceptedTX.id)
      if (queueEntry != null && queueEntry.transactionGroup != null && this.p2p.getNodeId() === queueEntry.transactionGroup[0].id) {
        this.stateManager.eventEmitter.emit('txProcessed')
      }
      this.stateManager.eventEmitter.emit('txApplied', acceptedTX)

      this.stateManager.partitionStats.statsTxSummaryUpdate(queueEntry.cycleToRecordOn, queueEntry)
      for (let wrappedData of applyResponse.accountData) {
        //this.stateManager.partitionStats.statsDataSummaryUpdate(wrappedData.prevDataCopy, wrappedData)

        let queueData = queueEntry.collectedData[wrappedData.accountId]

        if (queueData != null) {
          if (queueData.accountCreated) {
            //account was created to do a summary init
            //this.stateManager.partitionStats.statsDataSummaryInit(queueEntry.cycleToRecordOn, queueData);
            this.stateManager.partitionStats.statsDataSummaryInitRaw(queueEntry.cycleToRecordOn, queueData.accountId, queueData.prevDataCopy)
          }
          this.stateManager.partitionStats.statsDataSummaryUpdate2(queueEntry.cycleToRecordOn, queueData.prevDataCopy, wrappedData)
        } else {
          this.mainLogger.error(`commitConsensedTransaction failed to get account data for stats ${wrappedData.accountId}`)
        }
      }
    }

    return { success: true }
  }

  /**
   * preApplyAcceptedTransaction will apply a transaction to the in memory data but will not save the results to the database yet
   * @param acceptedTX
   * @param wrappedStates
   * @param localCachedData
   * @param filter
   */
  async preApplyAcceptedTransaction(acceptedTX: AcceptedTx, wrappedStates: WrappedResponses, localCachedData: LocalCachedData, filter: AccountFilter): Promise<PreApplyAcceptedTransactionResult> {
    if (this.queueStopped) return
    let tx = acceptedTX.data
    let keysResponse = this.app.getKeyFromTransaction(tx)
    let { sourceKeys, targetKeys, timestamp, debugInfo } = keysResponse

    if (this.verboseLogs) console.log('preApplyAcceptedTransaction ' + timestamp + ' debugInfo:' + debugInfo)
    if (this.verboseLogs) this.mainLogger.debug('applyAcceptedTransaction ' + timestamp + ' debugInfo:' + debugInfo)

    let allkeys: string[] = []
    allkeys = allkeys.concat(sourceKeys)
    allkeys = allkeys.concat(targetKeys)

    for (let key of allkeys) {
      if (wrappedStates[key] == null) {
        if (this.verboseLogs) console.log(`preApplyAcceptedTransaction missing some account data. timestamp:${timestamp}  key: ${utils.makeShortHash(key)}  debuginfo:${debugInfo}`)
        return { applied: false, passed: false, applyResult: '', reason: 'missing some account data' }
      } else {
        let wrappedState = wrappedStates[key]
        wrappedState.prevStateId = wrappedState.stateId

        wrappedState.prevDataCopy = utils.deepCopy(wrappedState.data)

        //important to update the wrappedState timestamp here to prevent bad timestamps from propagating the system
        let { timestamp: updatedTimestamp, hash: updatedHash } = this.app.getTimestampAndHashFromAccount(wrappedState.data)
        wrappedState.timestamp = updatedTimestamp
      }
    }

    // todo review what we are checking here.
    let { success, hasStateTableData } = await this.testAccountTimesAndStateTable2(tx, wrappedStates)

    if (!success) {
      if (this.verboseLogs) this.mainLogger.debug('preApplyAcceptedTransaction pretest failed: ' + timestamp)
      if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('tx_preapply_rejected 1', `${acceptedTX.id}`, `Transaction: ${utils.stringifyReduce(acceptedTX)}`)
      return { applied: false, passed: false, applyResult: '', reason: 'preApplyAcceptedTransaction pretest failed, TX rejected' }
    }

    // TODO STATESHARDING4 I am not sure if this really needs to be split into a function anymore.
    // That mattered with data repair in older versions of the code, but that may be the wrong thing to do now
    let preApplyResult = await this.tryPreApplyTransaction(acceptedTX, hasStateTableData, false, filter, wrappedStates, localCachedData)

    if (preApplyResult) {
      if (this.verboseLogs) this.mainLogger.debug('preApplyAcceptedTransaction SUCCEDED ' + timestamp)
      if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('tx_preapplied', `${acceptedTX.id}`, `AcceptedTransaction: ${utils.stringifyReduce(acceptedTX)}`)
    } else {
      if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('tx_preapply_rejected 3', `${acceptedTX.id}`, `Transaction: ${utils.stringifyReduce(acceptedTX)}`)
    }

    return { applied: true, passed: preApplyResult.passed, applyResult: preApplyResult.applyResult, reason: 'apply result', applyResponse: preApplyResult.applyResponse }
  }

  updateHomeInformation(txQueueEntry: QueueEntry) {
    if (this.stateManager.currentCycleShardData != null && txQueueEntry.hasShardInfo === false) {
      let txId = txQueueEntry.acceptedTx.receipt.txHash
      // Init home nodes!
      for (let key of txQueueEntry.txKeys.allKeys) {
        if (key == null) {
          throw new Error(`updateHomeInformation key == null ${key}`)
        }
        let homeNode = ShardFunctions.findHomeNode(this.stateManager.currentCycleShardData.shardGlobals, key, this.stateManager.currentCycleShardData.parititionShardDataMap)
        if (homeNode == null) {
          throw new Error(`updateHomeInformation homeNode == null ${key}`)
        }
        txQueueEntry.homeNodes[key] = homeNode
        if (homeNode == null) {
          if (this.verboseLogs) this.mainLogger.error(` routeAndQueueAcceptedTransaction: ${key} `)
          throw new Error(`updateHomeInformation homeNode == null ${txQueueEntry}`)
        }

        // calculate the partitions this TX is involved in for the receipt map
        let isGlobalAccount = this.stateManager.accountGlobals.isGlobalAccount(key)
        if (isGlobalAccount === true) {
          txQueueEntry.involvedPartitions.push(homeNode.homePartition)
          txQueueEntry.involvedGlobalPartitions.push(homeNode.homePartition)
        } else {
          txQueueEntry.involvedPartitions.push(homeNode.homePartition)
        }

        // HOMENODEMATHS Based on home node.. should this be chaned to homepartition?
        let summaryObject = ShardFunctions.getHomeNodeSummaryObject(homeNode)
        let relationString = ShardFunctions.getNodeRelation(homeNode, this.stateManager.currentCycleShardData.ourNode.id)
        // route_to_home_node
        if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_homeNodeSummary', `${txId}`, `account:${utils.makeShortHash(key)} rel:${relationString} summary:${utils.stringifyReduce(summaryObject)}`)
      }

      txQueueEntry.hasShardInfo = true
    }
  }

  /***
   *    ######## ##    ##  #######  ##     ## ######## ##     ## ########
   *    ##       ###   ## ##     ## ##     ## ##       ##     ## ##
   *    ##       ####  ## ##     ## ##     ## ##       ##     ## ##
   *    ######   ## ## ## ##     ## ##     ## ######   ##     ## ######
   *    ##       ##  #### ##  ## ## ##     ## ##       ##     ## ##
   *    ##       ##   ### ##    ##  ##     ## ##       ##     ## ##
   *    ######## ##    ##  ##### ##  #######  ########  #######  ########
   */

  routeAndQueueAcceptedTransaction(acceptedTx: AcceptedTx, sendGossip: boolean = true, sender: Shardus.Node | null, globalModification: boolean, noConsensus: boolean): string | boolean {
    // dropping these too early.. hmm  we finished syncing before we had the first shard data.
    // if (this.stateManager.currentCycleShardData == null) {
    //   // this.preTXQueue.push(acceptedTX)
    //   return 'notReady' // it is too early to care about the tx
    // }
    if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('routeAndQueueAcceptedTransaction-debug', '', `sendGossip:${sendGossip} globalModification:${globalModification} noConsensus:${noConsensus} this.readyforTXs:${this.stateManager.accountSync.readyforTXs} hasshardData:${this.stateManager.currentCycleShardData != null} acceptedTx:${utils.stringifyReduce(acceptedTx)} `)
    if (this.stateManager.accountSync.readyforTXs === false) {
      if (this.verboseLogs) this.mainLogger.error(`routeAndQueueAcceptedTransaction too early for TX: this.readyforTXs === false`)
      return 'notReady' // it is too early to care about the tx
    }
    if (this.stateManager.currentCycleShardData == null) {
      if (this.verboseLogs) this.mainLogger.error(`routeAndQueueAcceptedTransaction too early for TX: this.stateManager.currentCycleShardData == null`)
      return 'notReady'
    }

    try {
      this.profiler.profileSectionStart('enqueue')

      if (this.stateManager.accountGlobals.hasknownGlobals == false) {
        if (this.verboseLogs) this.mainLogger.error(`routeAndQueueAcceptedTransaction too early for TX: hasknownGlobals == false`)
        return 'notReady'
      }

      let keysResponse = this.app.getKeyFromTransaction(acceptedTx.data)
      let timestamp = keysResponse.timestamp
      let txId = acceptedTx.receipt.txHash

      // This flag turns of consensus for all TXs for debuggging
      if (this.stateManager.debugNoTxVoting === true) {
        noConsensus = true
      }

      let cycleNumber = this.stateManager.currentCycleShardData.cycleNumber

      this.queueEntryCounter++
      let txQueueEntry: QueueEntry = {
        acceptedTx: acceptedTx,
        txKeys: keysResponse,
        noConsensus,
        collectedData: {},
        originalData: {},
        beforeHashes: {},
        homeNodes: {},
        patchedOnNodes: new Map(),
        hasShardInfo: false,
        state: 'aging',
        dataCollected: 0,
        hasAll: false,
        entryID: this.queueEntryCounter,
        localKeys: {},
        localCachedData: {},
        syncCounter: 0,
        didSync: false,
        didWakeup: false,
        syncKeys: [],
        logstate: '',
        requests: {},
        globalModification: globalModification,
        collectedVotes: [],
        waitForReceiptOnly: false,
        m2TimeoutReached: false,
        debugFail_voteFlip: false,
        requestingReceipt: false,
        cycleToRecordOn: -5,
        involvedPartitions: [],
        involvedGlobalPartitions: [],
        shortReceiptHash: '',
        requestingReceiptFailed: false,
        approximateCycleAge: cycleNumber,
        ourNodeInTransactionGroup: false,
        ourNodeInConsensusGroup: false,
        logID: '',
        txGroupDebug: '',
        uniqueWritableKeys: [],
      } // age comes from timestamp

      // todo faster hash lookup for this maybe?
      let entry = this.getQueueEntrySafe(acceptedTx.id) // , acceptedTx.timestamp)
      if (entry) {
        return false // already in our queue, or temp queue
      }

      txQueueEntry.logID = utils.makeShortHash(acceptedTx.id)
      // if (this.config.debug != null && this.config.debug.loseTxChance && this.config.debug.loseTxChance > 0) {
      //   let rand = Math.random()
      //   if (this.config.debug.loseTxChance > rand) {
      //     if (this.app.canDebugDropTx(acceptedTx.data)) {
      //       if (this.logger.playbackLogEnabled ) this.logger.playbackLogNote('tx_dropForTest', txId, 'dropping tx ' + timestamp)
      //       return 'lost'
      //     }
      //   }
      // }

      this.stateManager.debugTXHistory[txQueueEntry.logID] = 'enteredQueue'

      if (this.app.canDebugDropTx(acceptedTx.data)) {
        if (this.stateManager.testFailChance(this.stateManager.loseTxChance, 'loseTxChance', utils.stringifyReduce(acceptedTx.id), '', this.verboseLogs) === true) {
          return 'lost'
        }

        if (this.stateManager.testFailChance(this.stateManager.voteFlipChance, 'voteFlipChance', utils.stringifyReduce(acceptedTx.id), '', this.verboseLogs) === true) {
          txQueueEntry.debugFail_voteFlip = true
        }
      }

      // if (this.config.debug != null && this.config.debug.loseTxChance && this.config.debug.loseTxChance > 0) {
      //   let rand = Math.random()
      //   if (this.config.debug.loseTxChance > rand) {
      //     if (this.app.canDebugDropTx(acceptedTx.data)) {
      //       this.mainLogger.error('tx_failReceiptTest fail vote tx  ' + txId + ' ' + timestamp)
      //       if (this.logger.playbackLogEnabled ) this.logger.playbackLogNote('tx_failReceiptTest', txId, 'fail vote tx ' + timestamp)
      //       //return 'lost'
      //       txQueueEntry.debugFail_voteFlip = true
      //     }
      //   }
      // } else {
      //   // this.mainLogger.error('tx_failReceiptTest set  ' + this.config.debug.loseTxChance)
      //   // this.config.debug.loseTxChance = 0
      // }

      try {
        let age = Date.now() - timestamp
        if (age > this.stateManager.queueSitTime * 0.9) {
          this.statemanager_fatal(`routeAndQueueAcceptedTransaction_olderTX`, 'routeAndQueueAcceptedTransaction working on older tx ' + timestamp + ' age: ' + age)
          // TODO consider throwing this out.  right now it is just a warning
          if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_oldQueueInsertion', '', 'routeAndQueueAcceptedTransaction working on older tx ' + timestamp + ' age: ' + age)
        }
        let keyHash: StringBoolObjectMap = {}
        for (let key of txQueueEntry.txKeys.allKeys) {
          if (key == null) {
            // throw new Error(`routeAndQueueAcceptedTransaction key == null ${key}`)
            if (this.verboseLogs) this.mainLogger.error(`routeAndQueueAcceptedTransaction key == null ${timestamp} not putting tx in queue.`)
            return false
          }

          keyHash[key] = true
        }
        txQueueEntry.uniqueKeys = Object.keys(keyHash)

        this.updateHomeInformation(txQueueEntry)

        // calculate information needed for receiptmap
        txQueueEntry.cycleToRecordOn = this.stateManager.getCycleNumberFromTimestamp(timestamp)
        if (txQueueEntry.cycleToRecordOn < 0) {
          if (this.verboseLogs) this.mainLogger.error(`routeAndQueueAcceptedTransaction failed to calculate cycle ${timestamp} error code:${txQueueEntry.cycleToRecordOn}`)
          return false
        }

        // Global account keys.
        for (let key of txQueueEntry.uniqueKeys) {
          if (globalModification === true) {
            // TODO: globalaccounts
            if (this.stateManager.accountGlobals.globalAccountMap.has(key)) {
              if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('globalAccountMap', `routeAndQueueAcceptedTransaction - has`)
              // indicate that we will have global data in this transaction!
              // I think we do not need to test that here afterall.
            } else {
              //this makes the code aware that this key is for a global account.
              //is setting this here too soon?
              //it should be that p2p has already checked the receipt before calling shardus.push with global=true

              this.stateManager.accountGlobals.globalAccountMap.set(key, null)
              if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('globalAccountMap', `routeAndQueueAcceptedTransaction - set`)
            }
          }
        }
        //let transactionGroup = this.queueEntryGetTransactionGroup(txQueueEntry)
        // if we are syncing this area mark it as good.
        for (let key of txQueueEntry.uniqueKeys) {
          let syncTracker = this.stateManager.accountSync.getSyncTracker(key)
          if (syncTracker != null) {
            txQueueEntry.state = 'syncing'
            txQueueEntry.syncCounter++
            txQueueEntry.didSync = true // mark that this tx had to sync, this flag should never be cleared, we will use it later to not through stuff away.
            syncTracker.queueEntries.push(txQueueEntry) // same tx may get pushed in multiple times. that's ok.
            txQueueEntry.syncKeys.push(key) // used later to instruct what local data we should JIT load
            txQueueEntry.localKeys[key] = true // used for the filter

            if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_sync_queued_and_set_syncing', `${txQueueEntry.acceptedTx.id}`, `${txQueueEntry.logID} qId: ${txQueueEntry.entryID}`)
          }
        }

        for (let key of txQueueEntry.uniqueKeys) {
          let isGlobalAcc = this.stateManager.accountGlobals.isGlobalAccount(key)

          // if it is a global modification and global account we can write
          if (globalModification === true && isGlobalAcc === true) {
            txQueueEntry.uniqueWritableKeys.push(key)
          }
          // if it is a normal transaction and non global account we can write
          if (globalModification === false && isGlobalAcc === false) {
            txQueueEntry.uniqueWritableKeys.push(key)
          }
        }

        //if we had any sync at all flag all non global partitions..
        if (txQueueEntry.didSync) {
          for (let key of txQueueEntry.uniqueKeys) {
            //if(this.stateManager.accountGlobals.globalAccountMap.has(key)){
            let { homePartition, addressNum } = ShardFunctions.addressToPartition(this.stateManager.currentCycleShardData.shardGlobals, key)
            this.stateManager.currentCycleShardData.partitionsToSkip.set(homePartition, true)
            //}
          }
        }

        if (txQueueEntry.hasShardInfo) {
          let transactionGroup = this.queueEntryGetTransactionGroup(txQueueEntry)
          if (txQueueEntry.ourNodeInTransactionGroup || txQueueEntry.didSync === true) {
            // go ahead and calculate this now if we are in the tx group or we are syncing this range!
            this.queueEntryGetConsensusGroup(txQueueEntry)
          }
          if (sendGossip && txQueueEntry.globalModification === false) {
            try {
              //let transactionGroup = this.queueEntryGetTransactionGroup(txQueueEntry)

              if (transactionGroup.length > 1) {
                // should consider only forwarding in some cases?
                this.stateManager.debugNodeGroup(txId, timestamp, `share to neighbors`, transactionGroup)
                this.p2p.sendGossipIn('spread_tx_to_group', acceptedTx, '', sender, transactionGroup)
              }
              // if (this.logger.playbackLogEnabled ) this.logger.playbackLogNote('tx_homeGossip', `${txId}`, `AcceptedTransaction: ${acceptedTX}`)
            } catch (ex) {
              this.statemanager_fatal(`txQueueEntry_ex`, 'txQueueEntry: ' + utils.stringifyReduce(txQueueEntry))
            }
          }

          if (txQueueEntry.didSync === false) {
            // see if our node shard data covers any of the accounts?
            //this.queueEntryGetTransactionGroup(txQueueEntry) // this will compute our involvment
            if (txQueueEntry.ourNodeInTransactionGroup === false && txQueueEntry.globalModification === false) {
              // if globalModification === true then every node is in the group
              if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_notInTxGroup', `${txId}`, ``)
              return 'out of range' // we are done, not involved!!!
            } else {
              // let tempList =  // can be returned by the function below
              if (this.verboseLogs) this.mainLogger.debug(`routeAndQueueAcceptedTransaction: getOrderedSyncingNeighbors`)
              this.p2p.state.getOrderedSyncingNeighbors(this.stateManager.currentCycleShardData.ourNode)
              // TODO: globalaccounts
              // globalModification  TODO pass on to syncing nodes.   (make it pass on the flag too)
              // possibly need to send proof to the syncing node or there could be a huge security loophole.  should share the receipt as an extra parameter
              // or data repair will detect and reject this if we get tricked.  could be an easy attack vector
              if (this.stateManager.currentCycleShardData.hasSyncingNeighbors === true) {
                if (txQueueEntry.globalModification === false) {
                  if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_sync_tx', `${txId}`, `txts: ${timestamp} nodes:${utils.stringifyReduce(this.stateManager.currentCycleShardData.syncingNeighborsTxGroup.map((x) => x.id))}`)
                  this.stateManager.debugNodeGroup(txId, timestamp, `share to syncing neighbors`, this.stateManager.currentCycleShardData.syncingNeighborsTxGroup)
                  this.p2p.sendGossipAll('spread_tx_to_group', acceptedTx, '', sender, this.stateManager.currentCycleShardData.syncingNeighborsTxGroup)
                  //This was using sendGossipAll, but changed it for a work around.  maybe this just needs to be a tell.
                } else {
                  if (this.verboseLogs) this.mainLogger.debug(`routeAndQueueAcceptedTransaction: bugfix detected. avoid forwarding txs where globalModification == true`)
                }
              }
            }
          }
        } else {
          throw new Error('missing shard info')
        }
        this.newAcceptedTxQueueTempInjest.push(txQueueEntry)

        // start the queue if needed
        this.stateManager.tryStartAcceptedQueue()
      } catch (error) {
        if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_addtoqueue_rejected', `${txId}`, `AcceptedTransaction: ${utils.makeShortHash(acceptedTx.id)} ts: ${txQueueEntry.txKeys.timestamp} acc: ${utils.stringifyReduce(txQueueEntry.txKeys.allKeys)}`)
        this.statemanager_fatal(`routeAndQueueAcceptedTransaction_ex`, 'routeAndQueueAcceptedTransaction failed: ' + error.name + ': ' + error.message + ' at ' + error.stack)
        throw new Error(error)
      }
      return true
    } finally {
      this.profiler.profileSectionEnd('enqueue')
    }
  }

  /***
   *     #######           ###     ######   ######  ########  ######   ######
   *    ##     ##         ## ##   ##    ## ##    ## ##       ##    ## ##    ##
   *    ##     ##        ##   ##  ##       ##       ##       ##       ##
   *    ##     ##       ##     ## ##       ##       ######    ######   ######
   *    ##  ## ##       ######### ##       ##       ##             ##       ##
   *    ##    ##        ##     ## ##    ## ##    ## ##       ##    ## ##    ##
   *     ##### ##       ##     ##  ######   ######  ########  ######   ######
   */

  getQueueEntry(txid: string): QueueEntry | null {
    // todo perf need an interpolated or binary search on a sorted list
    for (let queueEntry of this.newAcceptedTxQueue) {
      if (queueEntry.acceptedTx.id === txid) {
        return queueEntry
      }
    }
    return null
  }

  getQueueEntryPending(txid: string): QueueEntry | null {
    // todo perf need an interpolated or binary search on a sorted list
    for (let queueEntry of this.newAcceptedTxQueueTempInjest) {
      if (queueEntry.acceptedTx.id === txid) {
        return queueEntry
      }
    }
    return null
  }

  getQueueEntrySafe(txid: string): QueueEntry | null {
    let queueEntry = this.getQueueEntry(txid)
    if (queueEntry == null) {
      return this.getQueueEntryPending(txid)
    }

    return queueEntry
  }

  getQueueEntryArchived(txid: string, msg: string): QueueEntry | null {
    for (let queueEntry of this.archivedQueueEntries) {
      if (queueEntry.acceptedTx.id === txid) {
        return queueEntry
      }
    }
    // todo make this and error.
    this.mainLogger.error(`getQueueEntryArchived failed to find: ${utils.stringifyReduce(txid)} ${msg} dbg:${this.stateManager.debugTXHistory[utils.stringifyReduce(txid)]}`)

    return null
  }

  // TODO CODEREVIEW.  need to look at the use of local cache.  also is the early out ok?
  queueEntryAddData(queueEntry: QueueEntry, data: Shardus.WrappedResponse) {
    if (queueEntry.collectedData[data.accountId] != null) {
      return // already have the data
    }
    if (queueEntry.uniqueKeys == null) {
      // cant have all data yet if we dont even have unique keys.
      throw new Error(`Attempting to add data and uniqueKeys are not available yet: ${utils.stringifyReduceLimit(queueEntry, 200)}`)
    }
    queueEntry.collectedData[data.accountId] = data
    queueEntry.dataCollected++

    queueEntry.originalData[data.accountId] = stringify(data)
    queueEntry.beforeHashes[data.accountId] = data.stateId

    if (queueEntry.dataCollected === queueEntry.uniqueKeys.length) {
      //  queueEntry.tx Keys.allKeys.length
      queueEntry.hasAll = true
    }

    if (data.localCache) {
      queueEntry.localCachedData[data.accountId] = data.localCache
      delete data.localCache
    }

    if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_addData', `${utils.makeShortHash(queueEntry.acceptedTx.id)}`, `key ${utils.makeShortHash(data.accountId)} hash: ${utils.makeShortHash(data.stateId)} hasAll:${queueEntry.hasAll} collected:${queueEntry.dataCollected}  ${queueEntry.acceptedTx.timestamp}`)
  }

  queueEntryHasAllData(queueEntry: QueueEntry) {
    if (queueEntry.hasAll === true) {
      return true
    }
    if (queueEntry.uniqueKeys == null) {
      throw new Error(`queueEntryHasAllData (queueEntry.uniqueKeys == null)`)
    }
    let dataCollected = 0
    for (let key of queueEntry.uniqueKeys) {
      if (queueEntry.collectedData[key] != null) {
        dataCollected++
      }
    }
    if (dataCollected === queueEntry.uniqueKeys.length) {
      //  queueEntry.tx Keys.allKeys.length uniqueKeys.length
      queueEntry.hasAll = true
      return true
    }
    return false
  }

  async queueEntryRequestMissingData(queueEntry: QueueEntry) {
    if (this.stateManager.currentCycleShardData == null) {
      return
    }
    if (!queueEntry.requests) {
      queueEntry.requests = {}
    }
    if (queueEntry.uniqueKeys == null) {
      throw new Error('queueEntryRequestMissingData queueEntry.uniqueKeys == null')
    }

    let allKeys = []
    for (let key of queueEntry.uniqueKeys) {
      if (queueEntry.collectedData[key] == null) {
        allKeys.push(key)
      }
    }

    if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_queueEntryRequestMissingData_start', `${queueEntry.acceptedTx.id}`, `qId: ${queueEntry.entryID} AccountsMissing:${utils.stringifyReduce(allKeys)}`)

    // consensus group should have all the data.. may need to correct this later
    let consensusGroup = this.queueEntryGetConsensusGroup(queueEntry)
    //let consensusGroup = this.queueEntryGetTransactionGroup(queueEntry)

    for (let key of queueEntry.uniqueKeys) {
      if (queueEntry.collectedData[key] == null && queueEntry.requests[key] == null) {
        let keepTrying = true
        let triesLeft = 5
        // let triesLeft = Math.min(5, consensusGroup.length )
        // let nodeIndex = 0
        while (keepTrying) {
          if (triesLeft <= 0) {
            keepTrying = false
            break
          }
          triesLeft--
          let homeNodeShardData = queueEntry.homeNodes[key] // mark outstanding request somehow so we dont rerequest

          // let node = consensusGroup[nodeIndex]
          // nodeIndex++

          // find a random node to ask that is not us
          let node = null
          let randomIndex
          let foundValidNode = false
          let maxTries = 1000

          // todo make this non random!!!
          while (foundValidNode == false) {
            maxTries--
            randomIndex = this.stateManager.getRandomInt(homeNodeShardData.consensusNodeForOurNodeFull.length - 1)
            node = homeNodeShardData.consensusNodeForOurNodeFull[randomIndex]
            if (maxTries < 0) {
              //FAILED
              this.statemanager_fatal(`queueEntryRequestMissingData`, `queueEntryRequestMissingData: unable to find node to ask after 1000 tries tx:${utils.makeShortHash(queueEntry.acceptedTx.id)} key: ${utils.makeShortHash(key)} ${utils.stringifyReduce(homeNodeShardData.consensusNodeForOurNodeFull.map((x) => (x != null ? x.id : 'null')))}`)
              break
            }
            if (node == null) {
              continue
            }
            if (node.id === this.stateManager.currentCycleShardData.nodeShardData.node.id) {
              continue
            }
            foundValidNode = true
          }

          if (node == null) {
            continue
          }
          if (node.status != 'active') {
            continue
          }
          if (node === this.stateManager.currentCycleShardData.ourNode) {
            continue
          }

          // Todo: expand this to grab a consensus node from any of the involved consensus nodes.

          for (let key2 of allKeys) {
            queueEntry.requests[key2] = node
          }

          let relationString = ShardFunctions.getNodeRelation(homeNodeShardData, this.stateManager.currentCycleShardData.ourNode.id)
          if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_queueEntryRequestMissingData_ask', `${utils.makeShortHash(queueEntry.acceptedTx.id)}`, `r:${relationString}   asking: ${utils.makeShortHash(node.id)} qId: ${queueEntry.entryID} AccountsMissing:${utils.stringifyReduce(allKeys)}`)

          // Node Precheck!
          if (this.stateManager.isNodeValidForInternalMessage(node.id, 'queueEntryRequestMissingData', true, true) === false) {
            // if(this.tryNextDataSourceNode('queueEntryRequestMissingData') == false){
            //   break
            // }
            continue
          }

          let message = { keys: allKeys, txid: queueEntry.acceptedTx.id, timestamp: queueEntry.acceptedTx.timestamp }
          let result: RequestStateForTxResp = await this.p2p.ask(node, 'request_state_for_tx', message)

          if (result == null) {
            if (this.verboseLogs) {
              this.mainLogger.error('ASK FAIL request_state_for_tx')
            }
            if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_queueEntryRequestMissingData_askfailretry', `${utils.makeShortHash(queueEntry.acceptedTx.id)}`, `r:${relationString}   asking: ${utils.makeShortHash(node.id)} qId: ${queueEntry.entryID} `)
            continue
          }
          if (result.success !== true) {
            this.mainLogger.error('ASK FAIL queueEntryRequestMissingData 9')
            if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_queueEntryRequestMissingData_askfailretry2', `${utils.makeShortHash(queueEntry.acceptedTx.id)}`, `r:${relationString}   asking: ${utils.makeShortHash(node.id)} qId: ${queueEntry.entryID} `)
            continue
          }
          let dataCountReturned = 0
          let accountIdsReturned = []
          for (let data of result.stateList) {
            this.queueEntryAddData(queueEntry, data)
            dataCountReturned++
            accountIdsReturned.push(utils.makeShortHash(data.accountId))
          }

          if (queueEntry.hasAll === true) {
            queueEntry.logstate = 'got all missing data'
          } else {
            queueEntry.logstate = 'failed to get data:' + queueEntry.hasAll
            // queueEntry.state = 'failed to get data'
          }

          if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_queueEntryRequestMissingData_result', `${utils.makeShortHash(queueEntry.acceptedTx.id)}`, `r:${relationString}   result:${queueEntry.logstate} dataCount:${dataCountReturned} asking: ${utils.makeShortHash(node.id)} qId: ${queueEntry.entryID}  AccountsMissing:${utils.stringifyReduce(allKeys)} AccountsReturned:${utils.stringifyReduce(accountIdsReturned)}`)

          // queueEntry.homeNodes[key] = null
          for (let key2 of allKeys) {
            //consider deleteing these instead?
            //TSConversion changed to a delete opertaion should double check this
            //queueEntry.requests[key2] = null
            delete queueEntry.requests[key2]
          }

          if (queueEntry.hasAll === true) {
            break
          }

          keepTrying = false
        }
      }
    }
  }

  async queueEntryRequestMissingReceipt(queueEntry: QueueEntry) {
    if (this.stateManager.currentCycleShardData == null) {
      return
    }

    if (queueEntry.uniqueKeys == null) {
      throw new Error('queueEntryRequestMissingReceipt queueEntry.uniqueKeys == null')
    }

    if (queueEntry.requestingReceipt === true) {
      return
    }

    queueEntry.requestingReceipt = true

    if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_queueEntryRequestMissingReceipt_start', `${queueEntry.acceptedTx.id}`, `qId: ${queueEntry.entryID}`)

    let consensusGroup = this.queueEntryGetConsensusGroup(queueEntry)

    this.stateManager.debugNodeGroup(queueEntry.acceptedTx.id, queueEntry.acceptedTx.timestamp, `queueEntryRequestMissingReceipt`, consensusGroup)
    //let consensusGroup = this.queueEntryGetTransactionGroup(queueEntry)
    //the outer loop here could just use the transaction group of nodes instead. but already had this working in a similar function
    //TODO change it to loop the transaction group untill we get a good receipt
    let gotReceipt = false
    for (let key of queueEntry.uniqueKeys) {
      if (gotReceipt === true) {
        break
      }

      let keepTrying = true
      let triesLeft = Math.min(5, consensusGroup.length)
      let nodeIndex = 0
      while (keepTrying) {
        if (triesLeft <= 0) {
          keepTrying = false
          break
        }
        triesLeft--
        let homeNodeShardData = queueEntry.homeNodes[key] // mark outstanding request somehow so we dont rerequest

        let node = consensusGroup[nodeIndex]
        nodeIndex++
        // find a random node to ask that is not us
        // let node:Shardus.Node = null
        // let randomIndex
        // let foundValidNode = false
        // let maxTries = 1000
        // while (foundValidNode == false) {
        //   maxTries--
        //   randomIndex = this.stateManager.getRandomInt(homeNodeShardData.consensusNodeForOurNodeFull.length - 1)
        //   node = homeNodeShardData.consensusNodeForOurNodeFull[randomIndex]
        //   if(maxTries < 0){
        //     //FAILED
        //     this.fatalLogger.fatal(`queueEntryRequestMissingReceipt: unable to find node to ask after 1000 tries tx:${utils.makeShortHash(queueEntry.acceptedTx.id)} key: ${utils.makeShortHash(key)} ${utils.stringifyReduce(homeNodeShardData.consensusNodeForOurNodeFull.map((x)=> (x!=null)? x.id : 'null'))}`)
        //     break
        //   }
        //   if(node == null){
        //     continue
        //   }
        //   if(node.id === this.stateManager.currentCycleShardData.nodeShardData.node.id){
        //     continue
        //   }
        //   foundValidNode = true
        // }

        if (node == null) {
          continue
        }
        if (node.status != 'active') {
          continue
        }
        if (node === this.stateManager.currentCycleShardData.ourNode) {
          continue
        }

        let relationString = ShardFunctions.getNodeRelation(homeNodeShardData, this.stateManager.currentCycleShardData.ourNode.id)
        if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_queueEntryRequestMissingReceipt_ask', `${utils.makeShortHash(queueEntry.acceptedTx.id)}`, `r:${relationString}   asking: ${utils.makeShortHash(node.id)} qId: ${queueEntry.entryID} `)

        // Node Precheck!
        if (this.stateManager.isNodeValidForInternalMessage(node.id, 'queueEntryRequestMissingReceipt', true, true) === false) {
          // if(this.tryNextDataSourceNode('queueEntryRequestMissingReceipt') == false){
          //   break
          // }
          continue
        }

        let message = { txid: queueEntry.acceptedTx.id, timestamp: queueEntry.acceptedTx.timestamp }
        let result: RequestReceiptForTxResp = await this.p2p.ask(node, 'request_receipt_for_tx', message) // not sure if we should await this.

        if (result == null) {
          if (this.verboseLogs) {
            this.mainLogger.error(`ASK FAIL request_receipt_for_tx ${triesLeft} ${utils.makeShortHash(node.id)}`)
          }
          if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_queueEntryRequestMissingReceipt_askfailretry', `${utils.makeShortHash(queueEntry.acceptedTx.id)}`, `r:${relationString}   asking: ${utils.makeShortHash(node.id)} qId: ${queueEntry.entryID} `)
          continue
        }
        if (result.success !== true) {
          this.mainLogger.error(`ASK FAIL queueEntryRequestMissingReceipt 9 ${triesLeft} ${utils.makeShortHash(node.id)}:${utils.makeShortHash(node.internalPort)} note:${result.note} txid:${queueEntry.logID}`)
          continue
        }

        if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_queueEntryRequestMissingReceipt_result', `${utils.makeShortHash(queueEntry.acceptedTx.id)}`, `r:${relationString}   result:${queueEntry.logstate} asking: ${utils.makeShortHash(node.id)} qId: ${queueEntry.entryID} result: ${utils.stringifyReduce(result)}`)

        if (result.success === true && result.receipt != null) {
          queueEntry.recievedAppliedReceipt = result.receipt
          keepTrying = false
          gotReceipt = true

          this.mainLogger.error(`queueEntryRequestMissingReceipt got good receipt for: ${utils.makeShortHash(queueEntry.acceptedTx.id)} from: ${utils.makeShortHash(node.id)}:${utils.makeShortHash(node.internalPort)}`)
        }
      }

      // break the outer loop after we are done trying.  todo refactor this.
      if (keepTrying == false) {
        break
      }
    }
    queueEntry.requestingReceipt = false

    if (gotReceipt === false) {
      queueEntry.requestingReceiptFailed = true
    }
  }

  /**
   * queueEntryGetTransactionGroup
   * @param {QueueEntry} queueEntry
   * @returns {Node[]}
   */
  queueEntryGetTransactionGroup(queueEntry: QueueEntry): Shardus.Node[] {
    if (this.stateManager.currentCycleShardData == null) {
      throw new Error('queueEntryGetTransactionGroup: currentCycleShardData == null')
    }
    if (queueEntry.uniqueKeys == null) {
      throw new Error('queueEntryGetTransactionGroup: queueEntry.uniqueKeys == null')
    }
    if (queueEntry.transactionGroup != null) {
      return queueEntry.transactionGroup
    }
    let txGroup = []
    let uniqueNodes: StringNodeObjectMap = {}

    let hasNonGlobalKeys = false
    for (let key of queueEntry.uniqueKeys) {
      let homeNode = queueEntry.homeNodes[key]
      // txGroup = Array.concat(txGroup, homeNode.nodeThatStoreOurParitionFull)
      if (homeNode == null) {
        if (this.verboseLogs) this.mainLogger.debug('queueEntryGetTransactionGroup homenode:null')
      }
      if (homeNode.extendedData === false) {
        ShardFunctions.computeExtendedNodePartitionData(this.stateManager.currentCycleShardData.shardGlobals, this.stateManager.currentCycleShardData.nodeShardDataMap, this.stateManager.currentCycleShardData.parititionShardDataMap, homeNode, this.stateManager.currentCycleShardData.activeNodes)
      }

      //may need to go back and sync this logic with how we decide what partition to save a record in.

      // If this is not a global TX then skip tracking of nodes for global accounts used as a reference.
      if (queueEntry.globalModification === false) {
        if (this.stateManager.accountGlobals.isGlobalAccount(key) === true) {
          if (this.verboseLogs) this.mainLogger.debug(`queueEntryGetTransactionGroup skipping: ${utils.makeShortHash(key)} tx: ${utils.makeShortHash(queueEntry.acceptedTx.id)}`)
          continue
        } else {
          hasNonGlobalKeys = true
        }
      }

      for (let node of homeNode.nodeThatStoreOurParitionFull) {
        // not iterable!
        uniqueNodes[node.id] = node
      }

      let scratch1 = {}
      for (let node of homeNode.nodeThatStoreOurParitionFull) {
        // not iterable!
        scratch1[node.id] = true
      }
      // make sure the home node is in there in case we hit and edge case
      uniqueNodes[homeNode.node.id] = homeNode.node

      // TODO STATESHARDING4 is this next block even needed:
      // HOMENODEMATHS need to patch in nodes that would cover this partition!
      // TODO PERF make an optimized version of this in ShardFunctions that is smarter about which node range to check and saves off the calculation
      // maybe this could go on the partitions.
      let { homePartition } = ShardFunctions.addressToPartition(this.stateManager.currentCycleShardData.shardGlobals, key)
      if (homePartition != homeNode.homePartition) {
        //loop all nodes for now
        for (let nodeID of this.stateManager.currentCycleShardData.nodeShardDataMap.keys()) {
          let nodeShardData: NodeShardData = this.stateManager.currentCycleShardData.nodeShardDataMap.get(nodeID)
          let nodeStoresThisPartition = ShardFunctions.testInRange(homePartition, nodeShardData.storedPartitions)
          if (nodeStoresThisPartition === true && uniqueNodes[nodeID] == null) {
            //setting this will cause it to end up in the transactionGroup
            uniqueNodes[nodeID] = nodeShardData.node
            queueEntry.patchedOnNodes.set(nodeID, nodeShardData)
          }
          // build index for patched nodes based on the home node:
          if (nodeStoresThisPartition === true) {
            if (scratch1[nodeID] == null) {
              homeNode.patchedOnNodes.push(nodeShardData.node)
              scratch1[nodeID] = true
            }
          }
        }
      }
    }
    queueEntry.ourNodeInTransactionGroup = true
    if (uniqueNodes[this.stateManager.currentCycleShardData.ourNode.id] == null) {
      queueEntry.ourNodeInTransactionGroup = false
      if (this.verboseLogs) this.mainLogger.debug(`queueEntryGetTransactionGroup not involved: hasNonG:${hasNonGlobalKeys} tx ${utils.makeShortHash(queueEntry.acceptedTx.id)}`)
    }

    // make sure our node is included: needed for gossip! - although we may not care about the data!
    uniqueNodes[this.stateManager.currentCycleShardData.ourNode.id] = this.stateManager.currentCycleShardData.ourNode

    let values = Object.values(uniqueNodes)
    for (let v of values) {
      txGroup.push(v)
    }
    queueEntry.transactionGroup = txGroup
    return txGroup
  }

  /**
   * queueEntryGetConsensusGroup
   * Gets a merged results of all the consensus nodes for all of the accounts involved in the transaction
   * Ignores global accounts if globalModification == false and the account is global
   * @param {QueueEntry} queueEntry
   * @returns {Node[]}
   */
  queueEntryGetConsensusGroup(queueEntry: QueueEntry): Shardus.Node[] {
    if (this.stateManager.currentCycleShardData == null) {
      throw new Error('queueEntryGetConsensusGroup: currentCycleShardData == null')
    }
    if (queueEntry.uniqueKeys == null) {
      throw new Error('queueEntryGetConsensusGroup: queueEntry.uniqueKeys == null')
    }
    if (queueEntry.conensusGroup != null) {
      return queueEntry.conensusGroup
    }
    let txGroup = []
    let uniqueNodes: StringNodeObjectMap = {}

    let hasNonGlobalKeys = false
    for (let key of queueEntry.uniqueKeys) {
      let homeNode = queueEntry.homeNodes[key]
      if (homeNode == null) {
        if (this.verboseLogs) this.mainLogger.debug('queueEntryGetConsensusGroup homenode:null')
      }
      if (homeNode.extendedData === false) {
        ShardFunctions.computeExtendedNodePartitionData(this.stateManager.currentCycleShardData.shardGlobals, this.stateManager.currentCycleShardData.nodeShardDataMap, this.stateManager.currentCycleShardData.parititionShardDataMap, homeNode, this.stateManager.currentCycleShardData.activeNodes)
      }

      // TODO STATESHARDING4 GLOBALACCOUNTS is this next block of logic needed?
      // If this is not a global TX then skip tracking of nodes for global accounts used as a reference.
      if (queueEntry.globalModification === false) {
        if (this.stateManager.accountGlobals.isGlobalAccount(key) === true) {
          if (this.verboseLogs) this.mainLogger.debug(`queueEntryGetConsensusGroup skipping: ${utils.makeShortHash(key)} tx: ${utils.makeShortHash(queueEntry.acceptedTx.id)}`)
          continue
        } else {
          hasNonGlobalKeys = true
        }
      }

      for (let node of homeNode.consensusNodeForOurNodeFull) {
        uniqueNodes[node.id] = node
      }

      // make sure the home node is in there in case we hit and edge case
      uniqueNodes[homeNode.node.id] = homeNode.node
    }
    queueEntry.ourNodeInConsensusGroup = true
    if (uniqueNodes[this.stateManager.currentCycleShardData.ourNode.id] == null) {
      queueEntry.ourNodeInConsensusGroup = false
      if (this.verboseLogs) this.mainLogger.debug(`queueEntryGetConsensusGroup not involved: hasNonG:${hasNonGlobalKeys} tx ${utils.makeShortHash(queueEntry.acceptedTx.id)}`)
    }

    // make sure our node is included: needed for gossip! - although we may not care about the data!
    uniqueNodes[this.stateManager.currentCycleShardData.ourNode.id] = this.stateManager.currentCycleShardData.ourNode

    let values = Object.values(uniqueNodes)
    for (let v of values) {
      txGroup.push(v)
    }
    queueEntry.conensusGroup = txGroup
    return txGroup
  }

  /**
   * tellCorrespondingNodes
   * @param queueEntry
   * -sends account data to the correct involved nodees
   * -loads locally available data into the queue entry
   */
  async tellCorrespondingNodes(queueEntry: QueueEntry) {
    if (this.stateManager.currentCycleShardData == null) {
      throw new Error('tellCorrespondingNodes: currentCycleShardData == null')
    }
    if (queueEntry.uniqueKeys == null) {
      throw new Error('tellCorrespondingNodes: queueEntry.uniqueKeys == null')
    }
    // Report data to corresponding nodes
    let ourNodeData = this.stateManager.currentCycleShardData.nodeShardData
    // let correspondingEdgeNodes = []
    let correspondingAccNodes = []
    let dataKeysWeHave = []
    let dataValuesWeHave = []
    let datas: { [accountID: string]: any } = {}
    let remoteShardsByKey: { [accountID: string]: NodeShardData } = {} // shard homenodes that we do not have the data for.
    let loggedPartition = false
    for (let key of queueEntry.uniqueKeys) {
      ///   test here
      // let hasKey = ShardFunctions.testAddressInRange(key, ourNodeData.storedPartitions)
      // todo : if this works maybe a nicer or faster version could be used
      let hasKey = false
      let homeNode = queueEntry.homeNodes[key]
      if (homeNode.node.id === ourNodeData.node.id) {
        hasKey = true
      } else {
        for (let node of homeNode.nodeThatStoreOurParitionFull) {
          if (node.id === ourNodeData.node.id) {
            hasKey = true
            break
          }
        }
      }

      // HOMENODEMATHS tellCorrespondingNodes patch the value of hasKey
      // did we get patched in
      if (queueEntry.patchedOnNodes.has(ourNodeData.node.id)) {
        hasKey = true
      }

      // for(let patchedNodeID of queueEntry.patchedOnNodes.values()){
      // }

      let isGlobalKey = false
      //intercept that we have this data rather than requesting it.
      if (this.stateManager.accountGlobals.globalAccountMap.has(key)) {
        hasKey = true
        isGlobalKey = true
        if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('globalAccountMap', `tellCorrespondingNodes - has`)
      }

      if (hasKey === false) {
        if (loggedPartition === false) {
          loggedPartition = true
          if (this.verboseLogs) this.mainLogger.debug(`tellCorrespondingNodes hasKey=false: ${utils.stringifyReduce(homeNode.nodeThatStoreOurParitionFull.map((v) => v.id))}`)
          if (this.verboseLogs) this.mainLogger.debug(`tellCorrespondingNodes hasKey=false: full: ${utils.stringifyReduce(homeNode.nodeThatStoreOurParitionFull)}`)
        }
        if (this.verboseLogs) this.mainLogger.debug(`tellCorrespondingNodes hasKey=false  key: ${utils.stringifyReduce(key)}`)
      }

      if (hasKey) {
        // todo Detect if our node covers this paritition..  need our partition data
        let data = await this.app.getRelevantData(key, queueEntry.acceptedTx.data)
        //only queue this up to share if it is not a global account. global accounts dont need to be shared.

        //if this is not freshly created data then we need to make a backup copy of it!!
        //This prevents us from changing data before the commiting phase
        if (data.accountCreated == false) {
          data = utils.deepCopy(data)
        }

        if (isGlobalKey === false) {
          datas[key] = data
          dataKeysWeHave.push(key)
          dataValuesWeHave.push(data)
        }

        queueEntry.localKeys[key] = true
        // add this data to our own queue entry!!
        this.queueEntryAddData(queueEntry, data)
      } else {
        remoteShardsByKey[key] = queueEntry.homeNodes[key]
      }
    }
    if (queueEntry.globalModification === true) {
      if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('tellCorrespondingNodes', `tellCorrespondingNodes - globalModification = true, not telling other nodes`)
      return
    }

    let message
    let edgeNodeIds = []
    let consensusNodeIds = []

    let nodesToSendTo: StringNodeObjectMap = {}
    for (let key of queueEntry.uniqueKeys) {
      if (datas[key] != null) {
        for (let key2 of queueEntry.uniqueKeys) {
          if (key !== key2) {
            let localHomeNode = queueEntry.homeNodes[key]
            let remoteHomeNode = queueEntry.homeNodes[key2]

            let ourLocalConsensusIndex = localHomeNode.consensusNodeForOurNodeFull.findIndex((a) => a.id === ourNodeData.node.id)
            if (ourLocalConsensusIndex === -1) {
              continue
            }

            // must add one to each lookup index!
            let indicies = ShardFunctions.debugFastStableCorrespondingIndicies(localHomeNode.consensusNodeForOurNodeFull.length, remoteHomeNode.consensusNodeForOurNodeFull.length, ourLocalConsensusIndex + 1)
            let edgeIndicies = ShardFunctions.debugFastStableCorrespondingIndicies(localHomeNode.consensusNodeForOurNodeFull.length, remoteHomeNode.edgeNodes.length, ourLocalConsensusIndex + 1)

            let patchIndicies = []
            if (remoteHomeNode.patchedOnNodes.length > 0) {
              patchIndicies = ShardFunctions.debugFastStableCorrespondingIndicies(localHomeNode.consensusNodeForOurNodeFull.length, remoteHomeNode.patchedOnNodes.length, ourLocalConsensusIndex + 1)
            }

            // HOMENODEMATHS need to work out sending data to our patched range.
            // let edgeIndicies = ShardFunctions.debugFastStableCorrespondingIndicies(localHomeNode.consensusNodeForOurNodeFull.length, remoteHomeNode.edgeNodes.length, ourLocalConsensusIndex + 1)

            // for each remote node lets save it's id
            for (let index of indicies) {
              let node = remoteHomeNode.consensusNodeForOurNodeFull[index - 1] // fastStableCorrespondingIndicies is one based so adjust for 0 based array
              if (node != null && node.id !== ourNodeData.node.id) {
                nodesToSendTo[node.id] = node
                consensusNodeIds.push(node.id)
              }
            }
            for (let index of edgeIndicies) {
              let node = remoteHomeNode.edgeNodes[index - 1] // fastStableCorrespondingIndicies is one based so adjust for 0 based array
              if (node != null && node.id !== ourNodeData.node.id) {
                nodesToSendTo[node.id] = node
                edgeNodeIds.push(node.id)
              }
            }

            for (let index of patchIndicies) {
              let node = remoteHomeNode.edgeNodes[index - 1] // fastStableCorrespondingIndicies is one based so adjust for 0 based array
              if (node != null && node.id !== ourNodeData.node.id) {
                nodesToSendTo[node.id] = node
                //edgeNodeIds.push(node.id)
              }
            }

            correspondingAccNodes = Object.values(nodesToSendTo)
            let dataToSend = []
            dataToSend.push(datas[key]) // only sending just this one key at a time
            message = { stateList: dataToSend, txid: queueEntry.acceptedTx.id }
            if (correspondingAccNodes.length > 0) {
              let remoteRelation = ShardFunctions.getNodeRelation(remoteHomeNode, this.stateManager.currentCycleShardData.ourNode.id)
              let localRelation = ShardFunctions.getNodeRelation(localHomeNode, this.stateManager.currentCycleShardData.ourNode.id)
              if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_tellCorrespondingNodes', `${queueEntry.acceptedTx.id}`, `remoteRel: ${remoteRelation} localrel: ${localRelation} qId: ${queueEntry.entryID} AccountBeingShared: ${utils.makeShortHash(key)} EdgeNodes:${utils.stringifyReduce(edgeNodeIds)} ConsesusNodes${utils.stringifyReduce(consensusNodeIds)}`)

              // Filter nodes before we send tell()
              let filteredNodes = this.stateManager.filterValidNodesForInternalMessage(correspondingAccNodes, 'tellCorrespondingNodes', true, true)
              if (filteredNodes.length === 0) {
                this.mainLogger.error('tellCorrespondingNodes: filterValidNodesForInternalMessage no valid nodes left to try')
                return null
              }
              let filterdCorrespondingAccNodes = filteredNodes

              this.p2p.tell(filterdCorrespondingAccNodes, 'broadcast_state', message)
            }
          }
        }
      }
    }
  }

  /**
   * removeFromQueue remove an item from the queue and place it in the archivedQueueEntries list for awhile in case we have to access it again
   * @param {QueueEntry} queueEntry
   * @param {number} currentIndex
   */
  removeFromQueue(queueEntry: QueueEntry, currentIndex: number) {
    this.stateManager.eventEmitter.emit('txPopped', queueEntry.acceptedTx.receipt.txHash)
    this.newAcceptedTxQueue.splice(currentIndex, 1)
    this.archivedQueueEntries.push(queueEntry)
    // period cleanup will usually get rid of these sooner if the list fills up
    if (this.archivedQueueEntries.length > this.archivedQueueEntryMaxCount) {
      this.archivedQueueEntries.shift()
    }
  }

  /***
   *    ########  ########   #######   ######  ########  ######   ######
   *    ##     ## ##     ## ##     ## ##    ## ##       ##    ## ##    ##
   *    ##     ## ##     ## ##     ## ##       ##       ##       ##
   *    ########  ########  ##     ## ##       ######    ######   ######
   *    ##        ##   ##   ##     ## ##       ##             ##       ##
   *    ##        ##    ##  ##     ## ##    ## ##       ##    ## ##    ##
   *    ##        ##     ##  #######   ######  ########  ######   ######
   */
  async processAcceptedTxQueue() {
    let seenAccounts: SeenAccounts
    seenAccounts = {} // todo PERF we should be able to support using a variable that we save from one update to the next.  set that up after initial testing
    let pushedProfilerTag = null
    try {
      this.profiler.profileSectionStart('processQ')

      if (this.stateManager.currentCycleShardData == null) {
        return
      }

      if (this.newAcceptedTxQueue.length === 0 && this.newAcceptedTxQueueTempInjest.length === 0) {
        return
      }
      if (this.newAcceptedTxQueueRunning === true) {
        return
      }
      if (this.queueRestartCounter == null) {
        this.queueRestartCounter = 0
      }
      this.queueRestartCounter++

      let localRestartCounter = this.queueRestartCounter

      this.newAcceptedTxQueueRunning = true

      let acceptedTXCount = 0
      let edgeFailDetected = false

      let timeM = this.stateManager.queueSitTime
      let timeM2 = timeM * 2
      let timeM2_5 = timeM * 2.5
      let timeM3 = timeM * 3
      let currentTime = Date.now() // when to update this?

      // let seenAccounts2 = new Map()
      // todo move these functions out where they are not constantly regenerate
      let accountSeen = function (queueEntry: QueueEntry) {
        if (queueEntry.uniqueKeys == null) {
          //TSConversion double check if this needs extra logging
          return false
        }
        for (let key of queueEntry.uniqueKeys) {
          if (seenAccounts[key] != null) {
            return true
          }
          // if (seenAccounts2.has(key)) {
          //   this.fatalLogger.fatal('map fail in seenAccounts')
          //   return true
          // }
        }
        return false
      }
      let markAccountsSeen = function (queueEntry: QueueEntry) {
        if (queueEntry.uniqueWritableKeys == null) {
          //TSConversion double check if this needs extra logging
          return
        }
        // only mark writeable keys as seen but we will check/clear against all keys
        for (let key of queueEntry.uniqueWritableKeys) {
          if (seenAccounts[key] == null) {
            seenAccounts[key] = queueEntry
          }
          // seenAccounts2.set(key, true)
        }
      }
      // if we are the oldest ref to this you can clear it.. only ok because younger refs will still reflag it in time
      let clearAccountsSeen = function (queueEntry: QueueEntry) {
        if (queueEntry.uniqueKeys == null) {
          //TSConversion double check if this needs extra logging
          return
        }
        for (let key of queueEntry.uniqueKeys) {
          if (seenAccounts[key] === queueEntry) {
            seenAccounts[key] = null
          }
          // seenAccounts2.delete(key)
        }
      }

      let app = this.app
      let verboseLogs = this.verboseLogs
      let debugAccountData = function (queueEntry: QueueEntry, app: Shardus.App) {
        let debugStr = ''
        if (verboseLogs) {
          if (queueEntry.uniqueKeys == null) {
            //TSConversion double check if this needs extra logging
            return utils.makeShortHash(queueEntry.acceptedTx.id) + ' uniqueKeys empty error'
          }
          for (let key of queueEntry.uniqueKeys) {
            if (queueEntry.collectedData[key] != null) {
              debugStr += utils.makeShortHash(key) + ' : ' + app.getAccountDebugValue(queueEntry.collectedData[key]) + ', '
            }
          }
        }
        return debugStr
      }

      // process any new queue entries that were added to the temporary list
      if (this.newAcceptedTxQueueTempInjest.length > 0) {
        for (let txQueueEntry of this.newAcceptedTxQueueTempInjest) {
          let timestamp = txQueueEntry.txKeys.timestamp
          let acceptedTx = txQueueEntry.acceptedTx
          let txId = acceptedTx.receipt.txHash
          // sorted insert = sort by timestamp
          // todo faster version (binary search? to find where we need to insert)
          let index = this.newAcceptedTxQueue.length - 1
          let lastTx = this.newAcceptedTxQueue[index]

          while (index >= 0 && (timestamp > lastTx.txKeys.timestamp || (timestamp === lastTx.txKeys.timestamp && txId < lastTx.acceptedTx.id))) {
            index--
            lastTx = this.newAcceptedTxQueue[index]
          }

          //TODO check time before inserting queueEntry. make sure it is not older than 90% of M
          let age = Date.now() - timestamp
          if (age > timeM * 0.9) {
            // IT turns out the correct thing to check is didSync flag only report errors if we did not wait on this TX while syncing
            if (txQueueEntry.didSync == false) {
              this.statemanager_fatal(`processAcceptedTxQueue_oldTX.9`, 'processAcceptedTxQueue cannot accept tx older than 0.9M ' + timestamp + ' age: ' + age)
              if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_processAcceptedTxQueueTooOld1', `${utils.makeShortHash(txQueueEntry.acceptedTx.id)}`, 'processAcceptedTxQueue working on older tx ' + timestamp + ' age: ' + age)
              //txQueueEntry.waitForReceiptOnly = true
            }
          }
          if (age > timeM) {
            if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_processAcceptedTxQueueTooOld2', `${utils.makeShortHash(txQueueEntry.acceptedTx.id)}`, 'processAcceptedTxQueue working on older tx ' + timestamp + ' age: ' + age)
            txQueueEntry.waitForReceiptOnly = true
            txQueueEntry.state = 'consensing'
          }

          txQueueEntry.approximateCycleAge = this.stateManager.currentCycleShardData.cycleNumber
          this.newAcceptedTxQueue.splice(index + 1, 0, txQueueEntry)
          if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_addToQueue', `${txId}`, `AcceptedTransaction: ${utils.makeShortHash(acceptedTx.id)} ts: ${txQueueEntry.txKeys.timestamp} acc: ${utils.stringifyReduce(txQueueEntry.txKeys.allKeys)} indexInserted: ${index + 1}`)
          this.stateManager.eventEmitter.emit('txQueued', acceptedTx.receipt.txHash)
        }
        this.newAcceptedTxQueueTempInjest = []
      }

      let currentIndex = this.newAcceptedTxQueue.length - 1

      let lastLog = 0
      currentIndex++ //increment once so we can handle the decrement at the top of the loop and be safe about continue statements

      while (this.newAcceptedTxQueue.length > 0) {
        //Handle an odd case where the finally did not catch exiting scope.
        if (pushedProfilerTag != null) {
          this.profiler.profileSectionEnd(`process-${pushedProfilerTag}`)
          this.profiler.profileSectionEnd(`process-patched1-${pushedProfilerTag}`)
          pushedProfilerTag = null
        }

        currentIndex--
        if (currentIndex < 0) {
          break
        }
        let queueEntry: QueueEntry = this.newAcceptedTxQueue[currentIndex]
        let txTime = queueEntry.txKeys.timestamp
        let txAge = currentTime - txTime
        if (txAge < timeM) {
          break
        }

        if (localRestartCounter < this.queueRestartCounter && lastLog !== this.queueRestartCounter) {
          lastLog = this.queueRestartCounter
          if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('queueRestart_error', `${queueEntry.acceptedTx.id}`, `qId: ${queueEntry.entryID} qRst:${localRestartCounter}  qrstGlobal:${this.queueRestartCounter}}`)
        }
        // // fail the message if older than m3
        // if (queueEntry.hasAll === false && txAge > timeM3) {
        //   queueEntry.state = 'failed'
        //   removeFromQueue(queueEntry, currentIndex)
        //   continue
        // }

        this.stateManager.debugTXHistory[queueEntry.logID] = queueEntry.state

        let hasReceivedApplyReceipt = queueEntry.recievedAppliedReceipt != null
        let shortID = queueEntry.logID //`${utils.makeShortHash(queueEntry.acceptedTx.id)}`

        if (this.stateManager.accountSync.dataSyncMainPhaseComplete === true) {
          //check for TX older than M3 and expire them
          if (txAge > timeM3 && queueEntry.didSync == false) {
            //if(queueEntry.didSync == true && queueEntry.didWakeup == )
            //this.statistics.incrementCounter('txExpired')
            queueEntry.state = 'expired'
            this.removeFromQueue(queueEntry, currentIndex)
            if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('txExpired', `${shortID}`, `${queueEntry.txGroupDebug} txExpired ${utils.stringifyReduce(queueEntry.acceptedTx)}`)
            if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('txExpired', `${shortID}`, `${queueEntry.txGroupDebug} queueEntry.recievedAppliedReceipt: ${utils.stringifyReduce(queueEntry.recievedAppliedReceipt)}`)

            continue
          }
          if (txAge > timeM3 * 20 && queueEntry.didSync == true) {
            //this.statistics.incrementCounter('txExpired')
            queueEntry.state = 'expired'
            this.removeFromQueue(queueEntry, currentIndex)
            if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('txExpired', `${shortID}`, `${queueEntry.txGroupDebug} txExpired 2  ${utils.stringifyReduce(queueEntry.acceptedTx)} ${queueEntry.didWakeup}`)
            if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('txExpired', `${shortID}`, `${queueEntry.txGroupDebug} queueEntry.recievedAppliedReceipt 2: ${utils.stringifyReduce(queueEntry.recievedAppliedReceipt)}`)

            continue
          }

          if (txAge > timeM3 && queueEntry.requestingReceiptFailed) {
            //this.statistics.incrementCounter('txExpired')
            queueEntry.state = 'expired'
            this.removeFromQueue(queueEntry, currentIndex)
            if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('txExpired', `${shortID}`, `${queueEntry.txGroupDebug} txExpired 3 requestingReceiptFailed  ${utils.stringifyReduce(queueEntry.acceptedTx)} ${queueEntry.didWakeup}`)
            if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('txExpired', `${shortID}`, `${queueEntry.txGroupDebug} queueEntry.recievedAppliedReceipt 3 requestingReceiptFailed: ${utils.stringifyReduce(queueEntry.recievedAppliedReceipt)}`)
            continue
          }

          // if we have a pending request for a receipt mark account seen and continue
          if (queueEntry.requestingReceipt === true) {
            markAccountsSeen(queueEntry)
            continue
          }

          // This was checking at m2 before, but there was a chance that would be too early.
          // Checking at m2.5 allows the network a chance at a receipt existing
          if (txAge > timeM2_5 && queueEntry.didSync === true && queueEntry.requestingReceiptFailed === false) {
            if (queueEntry.recievedAppliedReceipt == null && queueEntry.appliedReceipt == null) {
              if (verboseLogs) this.mainLogger.error(`info: tx did sync. ask for receipt now:${shortID} `)
              if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('syncNeedsReceipt', `${shortID}`, `syncNeedsReceipt ${shortID}`)
              markAccountsSeen(queueEntry)
              this.queueEntryRequestMissingReceipt(queueEntry)
              continue
            }
          }

          // have not seen a receipt yet?
          if (txAge > timeM2_5 && queueEntry.requestingReceiptFailed === false) {
            if (queueEntry.recievedAppliedReceipt == null && queueEntry.appliedReceipt == null) {
              if (verboseLogs) this.mainLogger.error(`txMissingReceipt txid:${shortID} `)
              if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('txMissingReceipt', `${shortID}`, `txMissingReceipt ${shortID}`)
              markAccountsSeen(queueEntry)
              this.queueEntryRequestMissingReceipt(queueEntry)
              continue
            }
          }
        } else {
          //check for TX older than 10x M3 and expire them
          if (txAge > timeM3 * 10) {
            //this.statistics.incrementCounter('txExpired')
            queueEntry.state = 'expired'
            this.removeFromQueue(queueEntry, currentIndex)
            if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('txExpired', `${shortID}`, `${queueEntry.txGroupDebug} txExpired 4  ${utils.stringifyReduce(queueEntry.acceptedTx)}`)
            if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('txExpired', `${shortID}`, `${queueEntry.txGroupDebug} queueEntry.recievedAppliedReceipt 4: ${utils.stringifyReduce(queueEntry.recievedAppliedReceipt)}`)
            continue
          }
        }

        if (txAge > timeM2_5 && queueEntry.m2TimeoutReached === false && queueEntry.globalModification === false) {
          //if(queueEntry.recievedAppliedReceipt != null || queueEntry.appliedReceipt != null){
          if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_processAcceptedTxQueueTooOld3', `${shortID}`, 'processAcceptedTxQueue working on older tx ' + queueEntry.acceptedTx.timestamp + ' age: ' + txAge)
          queueEntry.waitForReceiptOnly = true
          queueEntry.m2TimeoutReached = true
          queueEntry.state = 'consensing'
          continue
          //}
        }

        // TODO STATESHARDING4 Does this queueEntry have a receipt?
        //
        //  A: if preapply results match the receipt results
        //  if we have the data we need to apply it:
        //       queueEntry.state = 'commiting'
        //
        //  B: if they dont match then
        //     -sync account from another node (based on hash values in receipt)
        //     Write the data that synced
        //
        //  C: if we get a receipt but have not pre applied yet?
        //     ? would still be waiting on data.
        //     this is not normal.  a node would be really behind.  Just do the data repair like step "B"

        try {
          this.profiler.profileSectionStart(`process-${queueEntry.state}`)
          pushedProfilerTag = queueEntry.state

          if (queueEntry.state === 'syncing') {
            ///////////////////////////////////////////////--syncing--////////////////////////////////////////////////////////////
            markAccountsSeen(queueEntry)
          } else if (queueEntry.state === 'aging') {
            ///////////////////////////////////////////--aging--////////////////////////////////////////////////////////////////
            // we know that tx age is greater than M
            queueEntry.state = 'processing'
            markAccountsSeen(queueEntry)
          } else if (queueEntry.state === 'processing') {
            ////////////////////////////////////////--processing--///////////////////////////////////////////////////////////////////
            if (accountSeen(queueEntry) === false) {
              markAccountsSeen(queueEntry)
              try {
                //if(queueEntry.globalModification === false) {
                await this.tellCorrespondingNodes(queueEntry)
                if (this.verboseLogs) if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_processing', `${shortID}`, `qId: ${queueEntry.entryID} qRst:${localRestartCounter}  values: ${debugAccountData(queueEntry, app)}`)
                //}
              } catch (ex) {
                this.mainLogger.debug('processAcceptedTxQueue2 tellCorrespondingNodes:' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
                this.statemanager_fatal(`processAcceptedTxQueue2_ex`, 'processAcceptedTxQueue2 tellCorrespondingNodes:' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
              } finally {
                queueEntry.state = 'awaiting data'
              }
            }
            markAccountsSeen(queueEntry)
          } else if (queueEntry.state === 'awaiting data') {
            ///////////////////////////////////////--awaiting data--////////////////////////////////////////////////////////////////////

            // TODO STATESHARDING4 GLOBALACCOUNTS need to find way to turn this back on..
            // if(queueEntry.globalModification === true){
            //   markAccountsSeen(queueEntry)
            //   // no data to await.
            //   queueEntry.state = 'applying'
            //   continue
            // }
            // check if we have all accounts
            if (queueEntry.hasAll === false && txAge > timeM2) {
              //TODO STATESHARDING4 in theory this shouldn't be able to happen

              markAccountsSeen(queueEntry)
              if (this.queueEntryHasAllData(queueEntry) === true) {
                // I think this can't happen
                if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_hadDataAfterall', `${shortID}`, `This is kind of an error, and should not happen`)
                continue
              }

              // if (queueEntry.hasAll === false && txAge > timeM3) {
              //   queueEntry.state = 'failed'
              //   removeFromQueue(queueEntry, currentIndex)
              //   continue
              // }

              // 7.  Manually request missing state
              try {
                // TODO consider if this function should set 'failed to get data'
                // note this is call is not awaited.  is that ok?
                //
                // TODO STATESHARDING4 should we await this.  I think no since this waits on outside nodes to respond
                this.queueEntryRequestMissingData(queueEntry)
              } catch (ex) {
                this.mainLogger.debug('processAcceptedTxQueue2 queueEntryRequestMissingData:' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
                this.statemanager_fatal(`processAcceptedTxQueue2_missingData`, 'processAcceptedTxQueue2 queueEntryRequestMissingData:' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
              }
            } else if (queueEntry.hasAll) {
              if (accountSeen(queueEntry) === false) {
                markAccountsSeen(queueEntry)

                // As soon as we have all the data we preApply it and then send out a vote
                if (this.verboseLogs) if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_preApplyTx', `${shortID}`, `qId: ${queueEntry.entryID} qRst:${localRestartCounter} values: ${debugAccountData(queueEntry, app)} AcceptedTransaction: ${utils.stringifyReduce(queueEntry.acceptedTx)}`)

                // TODO sync related need to reconsider how to set this up again
                // if (queueEntry.didSync) {
                //   if (this.logger.playbackLogEnabled ) this.logger.playbackLogNote('shrd_sync_consensing', `${queueEntry.acceptedTx.id}`, ` qId: ${queueEntry.entryID}`)
                //   // if we did sync it is time to JIT query local data.  alternatively could have other nodes send us this data, but that could be very high bandwidth.
                //   for (let key of queueEntry.syncKeys) {
                //     let wrappedState = await this.app.getRelevantData(key, queueEntry.acceptedTx.data)
                //     if (this.logger.playbackLogEnabled ) this.logger.playbackLogNote('shrd_sync_getLocalData', `${queueEntry.acceptedTx.id}`, ` qId: ${queueEntry.entryID}  key:${utils.makeShortHash(key)} hash:${wrappedState.stateId}`)
                //     queueEntry.localCachedData[key] = wrappedState.localCache
                //   }
                // }

                let wrappedStates = queueEntry.collectedData
                let localCachedData = queueEntry.localCachedData
                try {
                  let filter: AccountFilter = {}
                  // need to convert to map of numbers, could refactor this away later
                  for (let key of Object.keys(queueEntry.localKeys)) {
                    filter[key] = queueEntry[key] == true ? 1 : 0
                  }

                  // Need to go back and thing on how this was supposed to work:
                  // queueEntry.acceptedTx.transactionGroup = queueEntry.transactionGroup // Used to not double count txProcessed
                  let txResult = await this.preApplyAcceptedTransaction(queueEntry.acceptedTx, wrappedStates, localCachedData, filter)

                  // TODO STATESHARDING4 evaluate how much of this we still need, does the edge fail stuff still matter
                  if (txResult != null) {
                    if (txResult.passed === true) {
                      acceptedTXCount++
                    }
                    // clearAccountsSeen(queueEntry)
                  } else {
                    // clearAccountsSeen(queueEntry)
                    // if (!edgeFailDetected && acceptedTXCount > 0) {
                    //   edgeFailDetected = true
                    //   if (this.verboseLogs) this.mainLogger.debug( `processAcceptedTxQueue edgeFail ${utils.stringifyReduce(queueEntry.acceptedTx)}`)
                    //   this.fatalLogger.fatal( `processAcceptedTxQueue edgeFail ${utils.stringifyReduce(queueEntry.acceptedTx)}`) // todo: consider if this is just an error
                    // }
                  }

                  if (txResult != null && txResult.applied === true) {
                    queueEntry.state = 'consensing'

                    queueEntry.preApplyTXResult = txResult
                    //Broadcast our vote
                    if (queueEntry.noConsensus === true) {
                      // not sure about how to share or generate an applied receipt though for a no consensus step
                      if (this.verboseLogs) if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_preApplyTx_noConsensus', `${shortID}`, ``)

                      this.mainLogger.debug(`processAcceptedTxQueue2 noConsensus : ${queueEntry.logID} `)

                      //await this.stateManager.transactionConsensus.createAndShareVote(queueEntry)

                      queueEntry.state = 'commiting'

                      // if(queueEntry.globalModification === false){
                      //   //Send a special receipt because this is a set command.

                      // }
                    } else {
                      if (this.verboseLogs) if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_preApplyTx_createAndShareVote', `${shortID}`, ``)
                      this.mainLogger.debug(`processAcceptedTxQueue2 createAndShareVote : ${queueEntry.logID} `)
                      await this.stateManager.transactionConsensus.createAndShareVote(queueEntry)
                    }
                  } else {
                    this.mainLogger.error(`processAcceptedTxQueue2 txResult problem txid:${queueEntry.logID} res: ${utils.stringifyReduce(txResult)} `)
                    queueEntry.waitForReceiptOnly = true
                    queueEntry.state = 'consensing'
                  }
                } catch (ex) {
                  this.mainLogger.debug('processAcceptedTxQueue2 preApplyAcceptedTransaction:' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
                  this.statemanager_fatal(`processAcceptedTxQueue2b_ex`, 'processAcceptedTxQueue2 preApplyAcceptedTransaction:' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
                } finally {
                  if (this.verboseLogs) if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_preapplyFinish', `${shortID}`, `qId: ${queueEntry.entryID} qRst:${localRestartCounter} values: ${debugAccountData(queueEntry, app)} AcceptedTransaction: ${utils.stringifyReduce(queueEntry.acceptedTx)}`)
                }
              }
              markAccountsSeen(queueEntry)
            }
          } else if (queueEntry.state === 'consensing') {
            /////////////////////////////////////////--consensing--//////////////////////////////////////////////////////////////////
            if (accountSeen(queueEntry) === false) {
              markAccountsSeen(queueEntry)

              let didNotMatchReceipt = false

              this.mainLogger.debug(`processAcceptedTxQueue2 consensing : ${queueEntry.logID} receiptRcv:${hasReceivedApplyReceipt}`)
              let result = this.stateManager.transactionConsensus.tryProduceReceipt(queueEntry)
              if (result != null) {
                if (this.stateManager.transactionConsensus.hasAppliedReceiptMatchingPreApply(queueEntry, result)) {
                  if (this.verboseLogs) if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_consensingComplete_madeReceipt', `${shortID}`, `qId: ${queueEntry.entryID}  `)

                  // Broadcast the receipt
                  await this.stateManager.transactionConsensus.shareAppliedReceipt(queueEntry)
                  queueEntry.state = 'commiting'
                  continue
                } else {
                  if (this.verboseLogs) if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_consensingComplete_gotReceiptNoMatch1', `${shortID}`, `qId: ${queueEntry.entryID}  `)
                  didNotMatchReceipt = true
                  queueEntry.appliedReceiptForRepair = result
                }
              }

              // if we got a reciept while waiting see if we should use it
              if (hasReceivedApplyReceipt) {
                if (this.stateManager.transactionConsensus.hasAppliedReceiptMatchingPreApply(queueEntry, queueEntry.recievedAppliedReceipt)) {
                  if (this.verboseLogs) if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_consensingComplete_gotReceipt', `${shortID}`, `qId: ${queueEntry.entryID} `)
                  queueEntry.state = 'commiting'
                  continue
                } else {
                  if (this.verboseLogs) if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_consensingComplete_gotReceiptNoMatch2', `${shortID}`, `qId: ${queueEntry.entryID}  `)
                  didNotMatchReceipt = true
                  queueEntry.appliedReceiptForRepair = queueEntry.recievedAppliedReceipt
                }
              } else {
                //just keep waiting.
              }

              // we got a receipt but did not match it.
              if (didNotMatchReceipt === true) {
                if (this.verboseLogs) if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_consensingComplete_didNotMatchReceipt', `${shortID}`, `qId: ${queueEntry.entryID} result:${queueEntry.appliedReceiptForRepair.result} `)
                queueEntry.repairFinished = false
                if (queueEntry.appliedReceiptForRepair.result === true) {
                  // need to start repair process and wait
                  this.stateManager.transactionRepair.repairToMatchReceipt(queueEntry)
                  queueEntry.state = 'await repair'
                } else {
                  // we are finished since there is nothing to apply
                  this.removeFromQueue(queueEntry, currentIndex)
                  queueEntry.state = 'fail'
                }
              }
            }
            markAccountsSeen(queueEntry)
          } else if (queueEntry.state === 'await repair') {
            ///////////////////////////////////////////--await repair--////////////////////////////////////////////////////////////////
            markAccountsSeen(queueEntry)

            // at this point we are just waiting to see if we applied the data and repaired correctlyl
            if (queueEntry.repairFinished === true) {
              if (this.verboseLogs) if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_awaitRepair_repairFinished', `${shortID}`, `qId: ${queueEntry.entryID} result:${queueEntry.appliedReceiptForRepair.result} `)
              this.removeFromQueue(queueEntry, currentIndex)
              if (queueEntry.appliedReceiptForRepair.result === true) {
                queueEntry.state = 'pass'
              } else {
                // technically should never get here
                queueEntry.state = 'fail'
              }
            }
          } else if (queueEntry.state === 'commiting') {
            ///////////////////////////////////////////--commiting--////////////////////////////////////////////////////////////////
            if (accountSeen(queueEntry) === false) {
              markAccountsSeen(queueEntry)

              // TODO STATESHARDING4 Check if we have already commited the data from a receipt we saw earlier
              this.mainLogger.debug(`processAcceptedTxQueue2 commiting : ${queueEntry.logID} `)
              if (this.verboseLogs) if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_commitingTx', `${shortID}`, `qId: ${queueEntry.entryID} qRst:${localRestartCounter} values: ${debugAccountData(queueEntry, app)} AcceptedTransaction: ${utils.stringifyReduce(queueEntry.acceptedTx)}`)

              // if (this.verboseLogs) this.mainLogger.debug( ` processAcceptedTxQueue2. ${queueEntry.entryID} timestamp: ${queueEntry.txKeys.timestamp}`)

              // TODO STATESHARDING4 SYNC related need to reconsider how to set this up again
              // if (queueEntry.didSync) {
              //   if (this.logger.playbackLogEnabled ) this.logger.playbackLogNote('shrd_sync_commiting', `${queueEntry.acceptedTx.id}`, ` qId: ${queueEntry.entryID}`)
              //   // if we did sync it is time to JIT query local data.  alternatively could have other nodes send us this data, but that could be very high bandwidth.
              //   for (let key of queueEntry.syncKeys) {
              //     let wrappedState = await this.app.getRelevantData(key, queueEntry.acceptedTx.data)
              //     if (this.logger.playbackLogEnabled ) this.logger.playbackLogNote('shrd_sync_getLocalData', `${queueEntry.acceptedTx.id}`, ` qId: ${queueEntry.entryID}  key:${utils.makeShortHash(key)} hash:${wrappedState.stateId}`)
              //     queueEntry.localCachedData[key] = wrappedState.localCache
              //   }
              // }

              let wrappedStates = queueEntry.collectedData // Object.values(queueEntry.collectedData)
              let localCachedData = queueEntry.localCachedData
              try {
                let canCommitTX = true
                let hasReceiptFail = false
                if (queueEntry.noConsensus === true) {
                  // dont have a receipt for a non consensus TX. not even sure if we want to keep that!
                  if (queueEntry.preApplyTXResult.passed === false) {
                    canCommitTX = false
                  }
                } else if (queueEntry.appliedReceipt != null) {
                  // the final state of the queue entry will be pass or fail based on the receipt
                  if (queueEntry.appliedReceipt.result === false) {
                    canCommitTX = false
                    hasReceiptFail = true
                  }
                } else if (queueEntry.recievedAppliedReceipt != null) {
                  // the final state of the queue entry will be pass or fail based on the receipt
                  if (queueEntry.recievedAppliedReceipt.result === false) {
                    canCommitTX = false
                    hasReceiptFail = false
                  }
                } else {
                  canCommitTX = false
                }

                if (this.verboseLogs) if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_commitingTx', `${shortID}`, `canCommitTX: ${canCommitTX} `)
                if (canCommitTX) {
                  // this.mainLogger.debug(` processAcceptedTxQueue2. applyAcceptedTransaction ${queueEntry.entryID} timestamp: ${queueEntry.txKeys.timestamp} queuerestarts: ${localRestartCounter} queueLen: ${this.newAcceptedTxQueue.length}`)
                  let filter: AccountFilter = {}
                  // need to convert to map of numbers, could refactor this away later
                  for (let key of Object.keys(queueEntry.localKeys)) {
                    filter[key] = queueEntry[key] == true ? 1 : 0
                  }
                  // Need to go back and thing on how this was supposed to work:
                  //queueEntry.acceptedTx.transactionGroup = queueEntry.transactionGroup // Used to not double count txProcessed
                  let hasStateTableData = false
                  let repairing = false
                  //try {
                  this.profiler.profileSectionStart('commit')

                  let commitResult = await this.commitConsensedTransaction(
                    queueEntry.preApplyTXResult.applyResponse, // TODO STATESHARDING4 ... if we get here from a non standard path may need to get this data from somewhere else
                    queueEntry.acceptedTx,
                    hasStateTableData,
                    repairing,
                    filter,
                    wrappedStates,
                    localCachedData
                  )

                  //} finally {
                  this.profiler.profileSectionEnd('commit')
                  //}

                  if (commitResult != null && commitResult.success) {
                  }
                }
                if (hasReceiptFail) {
                  // endpoint to allow dapp to execute something that depends on a transaction failing

                  let applyReponse = queueEntry.preApplyTXResult.applyResponse // TODO STATESHARDING4 ... if we get here from a non standard path may need to get this data from somewhere else

                  this.app.transactionReceiptFail(queueEntry.acceptedTx.data, wrappedStates, applyReponse)
                }
              } catch (ex) {
                this.mainLogger.debug('processAcceptedTxQueue2 commiting Transaction:' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
                this.statemanager_fatal(`processAcceptedTxQueue2b_ex`, 'processAcceptedTxQueue2 commiting Transaction:' + ex.name + ': ' + ex.message + ' at ' + ex.stack)
              } finally {
                clearAccountsSeen(queueEntry)
                this.removeFromQueue(queueEntry, currentIndex)

                if (queueEntry.noConsensus === true) {
                  // dont have a receipt for a non consensus TX. not even sure if we want to keep that!
                  if (queueEntry.preApplyTXResult.passed === true) {
                    queueEntry.state = 'pass'
                  } else {
                    queueEntry.state = 'fail'
                  }
                  this.mainLogger.debug(`processAcceptedTxQueue2 commiting finished : noConsensus:${queueEntry.state} ${queueEntry.logID} `)
                } else if (queueEntry.appliedReceipt != null) {
                  // the final state of the queue entry will be pass or fail based on the receipt
                  if (queueEntry.appliedReceipt.result === true) {
                    queueEntry.state = 'pass'
                  } else {
                    queueEntry.state = 'fail'
                  }
                  this.mainLogger.debug(`processAcceptedTxQueue2 commiting finished : Recpt:${queueEntry.state} ${queueEntry.logID} `)
                } else if (queueEntry.recievedAppliedReceipt != null) {
                  // the final state of the queue entry will be pass or fail based on the receipt
                  if (queueEntry.recievedAppliedReceipt.result === true) {
                    queueEntry.state = 'pass'
                  } else {
                    queueEntry.state = 'fail'
                  }
                  this.mainLogger.debug(`processAcceptedTxQueue2 commiting finished : recvRecpt:${queueEntry.state} ${queueEntry.logID} `)
                } else {
                  queueEntry.state = 'fail'

                  this.mainLogger.error(`processAcceptedTxQueue2 commiting finished : no receipt ${queueEntry.logID} `)
                }

                if (this.verboseLogs) if (this.logger.playbackLogEnabled) this.logger.playbackLogNote('shrd_commitingTxFinished', `${queueEntry.acceptedTx.id}`, `qId: ${queueEntry.entryID} qRst:${localRestartCounter} values: ${debugAccountData(queueEntry, app)} AcceptedTransaction: ${utils.stringifyReduce(queueEntry.acceptedTx)}`)
              }

              // TODO STATESHARDING4 SYNC related.. need to consider how we will re activate this
              // // do we have any syncing neighbors?
              // if (this.stateManager.currentCycleShardData.hasSyncingNeighbors === true && queueEntry.globalModification === false) {
              // // let dataToSend = Object.values(queueEntry.collectedData)
              //   let dataToSend = []

              //   let keys = Object.keys(queueEntry.originalData)
              //   for (let key of keys) {
              //     dataToSend.push(JSON.parse(queueEntry.originalData[key]))
              //   }

              //   // maybe have to send localcache over, or require the syncing node to grab this data itself JIT!
              //   // let localCacheTransport = Object.values(queueEntry.localCachedData)

              //   // send data to syncing neighbors.
              //   if (this.stateManager.currentCycleShardData.syncingNeighbors.length > 0) {
              //     let message = { stateList: dataToSend, txid: queueEntry.acceptedTx.id }
              //     if (this.logger.playbackLogEnabled ) this.logger.playbackLogNote('shrd_sync_dataTell', `${queueEntry.acceptedTx.id}`, ` qId: ${queueEntry.entryID} AccountBeingShared: ${utils.stringifyReduce(queueEntry.txKeys.allKeys)} txid: ${utils.makeShortHash(message.txid)} nodes:${utils.stringifyReduce(this.stateManager.currentCycleShardData.syncingNeighbors.map(x => x.id))}`)
              //     this.p2p.tell(this.stateManager.currentCycleShardData.syncingNeighbors, 'broadcast_state', message)
              //   }
              // }
            }
          } else if (queueEntry.state === 'canceled') {
            ///////////////////////////////////////////////--canceled--////////////////////////////////////////////////////////////
            clearAccountsSeen(queueEntry)
            this.removeFromQueue(queueEntry, currentIndex)
            this.mainLogger.debug(`processAcceptedTxQueue2 canceled : ${queueEntry.logID} `)
          }
        } finally {
          this.profiler.profileSectionEnd(`process-${pushedProfilerTag}`)
          pushedProfilerTag = null // clear the tag
        }
        // Disabled this because it cant happen..  TXs will time out instead now.
        // we could consider this as a state when attempting to get missing data fails
        // else if (queueEntry.state === 'failed to get data') {
        //   this.removeFromQueue(queueEntry, currentIndex)
        // }
      }
    } finally {
      //Handle an odd case where the finally did not catch exiting scope.
      if (pushedProfilerTag != null) {
        this.profiler.profileSectionEnd(`process-${pushedProfilerTag}`)
        this.profiler.profileSectionEnd(`process-patched1-${pushedProfilerTag}`)
        pushedProfilerTag = null
      }

      // restart loop if there are still elements in it
      if (this.newAcceptedTxQueue.length > 0 || this.newAcceptedTxQueueTempInjest.length > 0) {
        setTimeout(() => {
          this.stateManager.tryStartAcceptedQueue()
        }, 15)
      }

      this.newAcceptedTxQueueRunning = false
      this.stateManager.lastSeenAccountsMap = seenAccounts

      this.profiler.profileSectionEnd('processQ')
    }
  }
}

export default TransactionQueue
