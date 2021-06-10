import { ShardusConfiguration } from '../shardus/shardus-types'
import Shardus = require('../shardus/shardus-types')
import { ShardGlobals, ShardInfo, WrappableParitionRange, NodeShardData, AddressRange, HomeNodeSummary, ParititionShardDataMap, NodeShardDataMap, MergeResults, BasicAddressRange } from './shardFunctionTypes'
import * as utils from '../utils'
const stringify = require('fast-stable-stringify')

import Profiler from '../utils/profiler'
import { P2PModuleContext as P2P } from '../p2p/Context'
import Storage from '../storage'
import Crypto from '../crypto'
import Logger, {logFlags} from '../logger'
import ShardFunctions from './shardFunctions.js'
import { time } from 'console'
import StateManager from '.'
import { nestedCountersInstance } from '../utils/nestedCounters'
import * as NodeList from '../p2p/NodeList'

import * as Comms from '../p2p/Comms'
import * as Context from '../p2p/Context'
//import { all } from 'deepmerge'
//import { Node } from '../p2p/Types'


class AccountPatcher {
  app: Shardus.App
  crypto: Crypto
  config: Shardus.ShardusConfiguration
  profiler: Profiler
  
  p2p: P2P

  logger: Logger

  mainLogger: any
  fatalLogger: any
  shardLogger: any
  statsLogger: any

  statemanager_fatal: (key: string, log: string) => void
  stateManager: StateManager

  treeMaxDepth: number
  treeSyncDepth: number
  shardTrie: ShardedHashTrie


  totalAccounts: number

  //accountUpdateQueueByCycle: Map<number, TrieAccount[]>
  accountUpdateQueue: TrieAccount[]
  accountUpdateQueueFuture: TrieAccount[]

  accountRemovalQueue: string[]

  hashTrieSyncConsensusByCycle: Map<number, HashTrieSyncConsensus>

  incompleteNodes: HashTrieNode[]

  debug_ignoreUpdates: boolean

  constructor(stateManager: StateManager, profiler: Profiler, app: Shardus.App, logger: Logger, p2p: P2P, crypto: Crypto, config: Shardus.ShardusConfiguration) {
    this.crypto = crypto
    this.app = app
    this.logger = logger
    this.config = config
    this.profiler = profiler
    this.p2p = p2p

    if(logger == null){
      
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
      layerMaps: []
    }
    //init or update layer maps. (treeMaxDepth doesn't count root so +1 it)
    for(let i=0; i< this.treeMaxDepth + 1 ; i++ ){
      this.shardTrie.layerMaps.push(new Map())
    }

    this.totalAccounts = 0

    this.hashTrieSyncConsensusByCycle = new Map()

    this.incompleteNodes = []

    this.accountUpdateQueue = []
    this.accountUpdateQueueFuture = []
    this.accountRemovalQueue = []

    this.debug_ignoreUpdates = false
  }

  hashObj(value:any){
    //could replace with a different cheaper hash!!
    return this.crypto.hash(value)
  }
  sortByAccountID(a, b){
    if (a.accountID < b.accountID) {
      return -1;
    }
    if (a.accountID > b.accountID) {
      return 1;
    }
    return 0;
  }
  sortByRadix(a, b){
    if (a.radix < b.radix) {
      return -1;
    }
    if (a.radix > b.radix) {
      return 1;
    }
    return 0;
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

  setupHandlers() {
    Comms.registerInternal('get_trie_hashes', async (payload: HashTrieReq, respond: (arg0: HashTrieResp) => any) => {
      let result = {nodeHashes:[]} as HashTrieResp

      for(let radix of payload.radixList){

        let level = radix.length
        let layerMap = this.shardTrie.layerMaps[level]

        let hashTrieNode = layerMap.get(radix)
        if(hashTrieNode != null){
          for(let childTreeNode of hashTrieNode.children){
            if(childTreeNode != null){
              result.nodeHashes.push({radix:childTreeNode.radix, hash:childTreeNode.hash})
            }
          }

          //result.nodeHashes.push({radix, hash:hashTrieNode.hash})
        }
      }
      await respond(result)
    })


    //this should be a tell to X..  robust tell? if a node does not get enough it can just query for more.
    Comms.registerInternal('sync_trie_hashes', async (payload: HashTrieSyncTell, respondWrapped, sender, tracker) => {
      let hashTrieSyncConsensus = this.hashTrieSyncConsensusByCycle.get(payload.cycle)
      if(hashTrieSyncConsensus == null){
        hashTrieSyncConsensus = {
          cycle:payload.cycle,
          radixHashVotes: new Map(),
          coverageMap: new Map()
        }
        this.hashTrieSyncConsensusByCycle.set(payload.cycle, hashTrieSyncConsensus)
      }

      const node = NodeList.nodes.get(sender)

      for(let nodeHashes of payload.nodeHashes){

        let hashVote = hashTrieSyncConsensus.radixHashVotes.get(nodeHashes.radix)
        if(hashVote == null){
          hashVote = {allVotes:new Map(), bestHash:nodeHashes.hash, bestVotes:1}
          hashTrieSyncConsensus.radixHashVotes.set(nodeHashes.radix, hashVote)
          hashVote.allVotes.set(nodeHashes.hash, {count:1, voters:[node]})
        } else {
          let voteEntry = hashVote.allVotes.get(nodeHashes.hash)
          if(voteEntry == null){
            hashVote.allVotes.set(nodeHashes.hash, {count:1, voters:[node]})
          } else {
            let voteCount = voteEntry.count + 1
            voteEntry.count = voteCount
            voteEntry.voters.push(node)
            //hashVote.allVotes.set(nodeHashes.hash, votes + 1)
            //will ties be a problem? (not if we need a majority!)
            if(voteCount > hashVote.bestVotes){
              hashVote.bestVotes = voteCount
              hashVote.bestHash = nodeHashes.hash
            }
          }
        }
      }
    })

    //get child accountHashes for radix.  //get the hashes and ids so we know what to fix.
    Comms.registerInternal('get_trie_accountHashes', async (payload: HashTrieReq, respond: (arg0: HashTrieAccountsResp) => any) => {

      //nodeChildHashes: {radix:string, childAccounts:{accountID:string, hash:string}[]}[]
      let result = {nodeChildHashes:[]} as HashTrieAccountsResp

      for(let radix of payload.radixList){

        let level = radix.length
        let layerMap = this.shardTrie.layerMaps[level]

        let hashTrieNode = layerMap.get(radix)
        if(hashTrieNode != null && hashTrieNode.accounts != null){
          let childAccounts = []
          result.nodeChildHashes.push({radix, childAccounts})
          for(let account of hashTrieNode.accounts){
            childAccounts.push({accountID:account.accountID, hash: account.hash})
          }
        }
      }
      await respond(result)
    })

    Comms.registerInternal('get_account_data_by_hashes', async (payload: HashTrieAccountDataRequest, respond: (arg0: HashTrieAccountDataResponse) => any) => {

      //nodeChildHashes: {radix:string, childAccounts:{accountID:string, hash:string}[]}[]
      let result:HashTrieAccountDataResponse = {accounts:[]}

      let hashMap = new Map()
      let accountIDs = []
      for(let accountHashEntry of payload.accounts){
        // let radix = accountHashEntry.accountID.substr(0, this.treeMaxDepth)
        // let layerMap = this.shardTrie.layerMaps[this.treeMaxDepth]
        // let hashTrieNode = layerMap.get(radix)

        hashMap[accountHashEntry.accountID] = accountHashEntry.hash
        accountIDs.push(accountHashEntry.accountID)
      }

      let accountData = await this.app.getAccountDataByList(accountIDs)

      // if (accountData != null) {
      //   for (let wrappedAccount of accountData) {
      //     let wrappedAccountInQueueRef = wrappedAccount as Shardus.WrappedDataFromQueue
      //     wrappedAccountInQueueRef.seenInQueue = false

      //     if (this.stateManager.lastSeenAccountsMap != null) {
      //       let queueEntry = this.stateManager.lastSeenAccountsMap[wrappedAccountInQueueRef.accountId]
      //       if (queueEntry != null) {
      //         wrappedAccountInQueueRef.seenInQueue = true
      //       }
      //     }
      //   }
      // }
      //PERF could disable this for more perf?
      this.stateManager.testAccountDataWrapped(accountData)

      result.accounts = accountData
      await respond(result)
    })


    Context.network.registerExternalGet('debug-patcher-ignore-hash-updates', (req, res) => {
      try{
        this.debug_ignoreUpdates = !this.debug_ignoreUpdates
        res.write(`this.debug_ignoreUpdates: ${this.debug_ignoreUpdates}\n`)  
      } catch(e){
        res.write(`${e}\n`) 
      }
      res.end()
    })
    Context.network.registerExternalGet('debug-patcher-fail-tx', (req, res) => {
      try{
        //toggle chance to fail TXs in a way that they do not get fixed by the first tier of repair.

        if(this.stateManager.failNoRepairTxChance === 0){
          this.stateManager.failNoRepairTxChance = 1
        } else {
          this.stateManager.failNoRepairTxChance = 0
        }

        res.write(`this.failNoRepairTxChance: ${this.stateManager.failNoRepairTxChance}\n`)  
      } catch(e){
        res.write(`${e}\n`) 
      }
      res.end()
    })


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

  upateShardTrie(cycle:number) : HashTrieUpdateStats {
    let currentLayer = this.treeMaxDepth
    let treeNodeQueue: HashTrieNode[] = []  

    let updateStats = {
      leafsUpdated: 0,
      leafsCreated: 0,
      updatedNodesPerLevel: new Array(this.treeMaxDepth+1).fill(0),
      hashedChildrenPerLevel: new Array(this.treeMaxDepth+1).fill(0),
      totalHashes: 0,
      //totalObjectsHashed: 0,
      totalNodesHashed: 0,
      totalAccountsHashed: 0,
      totalLeafs: 0,
    }

    // this.markIncompeteNodes(cycle)

    //feed account data into lowest layer, generates list of treeNodes
    let currentMap = this.shardTrie.layerMaps[currentLayer] 
    if(currentMap == null){
      currentMap = new Map()
      this.shardTrie.layerMaps[currentLayer] = currentMap
    }

    //let accountUpdateQueue = this.accountUpdateQueueByCycle.get(cycle)
    for(let i =0; i< this.accountUpdateQueue.length; i++){
      let tx = this.accountUpdateQueue[i]
      let key = tx.accountID.slice(0,currentLayer)
      let treeNode = currentMap.get(key)
      if(treeNode == null){
        //init a leaf 
        treeNode = {radix:key, children:[], childHashes:[], accounts:[], hash:'', accountTempMap:new Map(), updated:true, isIncomplete: false, nonSparseChildCount:0} //this map will cause issues with update
        currentMap.set(key, treeNode)
        //treeNodeQueue.push(treeNode)
        updateStats.leafsCreated++

        treeNodeQueue.push(treeNode)
      }

      //this can happen if the depth gets smaller after being larger
      if(treeNode.accountTempMap == null){
        //nestedCountersInstance.countEvent(`accountPatcher`, 'upateShardTrie: treeNode.accountTempMap == null')
        //this.statemanager_fatal('upateShardTrie: treeNode.accountTempMap == null', 'upateShardTrie: treeNode.accountTempMap == null')
        //continue
        treeNode.accountTempMap = new Map()
      }
      if(treeNode.accounts == null){
        treeNode.accounts = []
      }

      if(treeNode.accountTempMap.has(tx.accountID) === false){
        this.totalAccounts++
      }
      treeNode.accountTempMap.set(tx.accountID, tx)
      if(treeNode.updated === false){
        treeNodeQueue.push(treeNode)
        updateStats.leafsUpdated++
        
      }
      treeNode.updated= true
    }

    let removedAccounts = 0
    for(let i =0; i< this.accountRemovalQueue.length; i++){
      let accountID = this.accountRemovalQueue[i]

      let key = accountID.slice(0,currentLayer)
      let treeNode = currentMap.get(key)
      if(treeNode == null){
        continue //already gone!
      }  

      treeNode.updated = true
      treeNode.accountTempMap.delete(key)
      removedAccounts++
    }
    if(removedAccounts > 0){
      nestedCountersInstance.countEvent(`accountPatcher`, `removedAccounts c:${cycle}`, removedAccounts) 
    }
    
    // for(let treeNode of this.incompleteNodes){
    //   treeNodeQueue.push(treeNode)
    // }

    //sort accounts
    for(let i =0; i< treeNodeQueue.length; i++){
      let treeNode = treeNodeQueue[i]

      if( treeNode.updated === true  ){ //treeNode.accountTempMap != null){
        treeNode.accounts = Array.from(treeNode.accountTempMap.values())
        
        //delete treeNode.accountTempMap ... keeping it for now.

        //sort treeNode.accounts by accountID
        treeNode.accounts.sort(this.sortByAccountID)
        //compute treenode hash of accounts
        treeNode.hash = this.hashObj(treeNode.accounts.map(a=>a.hash))   //todo why is this needed!!!   
        
        treeNode.updated = false

        updateStats.totalHashes++
        updateStats.totalAccountsHashed = updateStats.totalAccountsHashed + treeNode.accounts.length
        updateStats.updatedNodesPerLevel[currentLayer] = updateStats.updatedNodesPerLevel[currentLayer] + 1
      }

    }

    let parentTreeNodeQueue = []
    //treenode queue has updated treeNodes from each loop, gets fed into next loop
    for(let i = currentLayer-1; i >= 0; i--){



      currentMap = this.shardTrie.layerMaps[i] 
      if(currentMap == null){
        currentMap = new Map()
        this.shardTrie.layerMaps[i] = currentMap
      }
      //loop each node in treeNodeQueue (nodes from the previous level down)
      for(let j = 0; j<treeNodeQueue.length; j++){
        let treeNode = treeNodeQueue[j]

        //compute parent nodes.
        let parentKey = treeNode.radix.slice(0, i)
        // fast? 0-15 conversion
        let index = treeNode.radix.charCodeAt(i)
        index = (index < 90)? index - 48: index -87
        //get parent node
        let parentTreeNode = currentMap.get(parentKey)
        if(parentTreeNode == null){
          parentTreeNode = {radix:parentKey, children:new Array(16), childHashes:new Array(16), updated:false, hash:'', isIncomplete: false, nonSparseChildCount:0}
          currentMap.set(parentKey, parentTreeNode)
                      
        }  

        //if we have not set this child yet then count it
        if(parentTreeNode.children[index] == null){
          parentTreeNode.nonSparseChildCount++
        } 

        parentTreeNode.children[index] = treeNode //assign position
        parentTreeNode.childHashes[index] = treeNode.hash

        //insert new parent nodes if we have not yet, guided by updated flag
        if(parentTreeNode.updated === false ){
          parentTreeNodeQueue.push(parentTreeNode)
          parentTreeNode.updated = true
        }

        if(treeNode.isIncomplete){
          // if(parentTreeNode.isIncomplete === false && parentTreeNode.updated === false ){
          //   parentTreeNode.updated = true
          //   parentTreeNodeQueue.push(parentTreeNode)
          // }
          parentTreeNode.isIncomplete = true
        }

        treeNode.updated = false //finished update of this node.
      }

      updateStats.updatedNodesPerLevel[i] = parentTreeNodeQueue.length

      //when we are one step below the sync depth add in incompete parents for hash updates!
      // if(i === this.treeSyncDepth + 1){
      //   for(let treeNode of this.incompleteNodes){
      //     parentTreeNodeQueue.push(treeNode)
      //   }
      // }

      //loop and compute hashes of parents
      for(let j = 0; j<parentTreeNodeQueue.length; j++){
        let parentTreeNode = parentTreeNodeQueue[j]
        parentTreeNode.hash = this.hashObj(parentTreeNode.childHashes)

        updateStats.totalHashes++
        updateStats.totalNodesHashed = updateStats.totalNodesHashed + parentTreeNode.nonSparseChildCount
        updateStats.hashedChildrenPerLevel[i] = updateStats.hashedChildrenPerLevel[i] + parentTreeNode.nonSparseChildCount
      }
      treeNodeQueue = parentTreeNodeQueue
      parentTreeNodeQueue = []
    }

    updateStats.totalLeafs = this.shardTrie.layerMaps[this.treeMaxDepth].size
    

    this.accountUpdateQueue = []

    return updateStats
  }



/***
 *    ##     ##    ###    ########  ##    ## #### ##    ##  ######   #######  ##     ## ########  ######## ######## ######## ##    ##  #######  ########  ########  ######  
 *    ###   ###   ## ##   ##     ## ##   ##   ##  ###   ## ##    ## ##     ## ###   ### ##     ## ##          ##    ##       ###   ## ##     ## ##     ## ##       ##    ## 
 *    #### ####  ##   ##  ##     ## ##  ##    ##  ####  ## ##       ##     ## #### #### ##     ## ##          ##    ##       ####  ## ##     ## ##     ## ##       ##       
 *    ## ### ## ##     ## ########  #####     ##  ## ## ## ##       ##     ## ## ### ## ########  ######      ##    ######   ## ## ## ##     ## ##     ## ######    ######  
 *    ##     ## ######### ##   ##   ##  ##    ##  ##  #### ##       ##     ## ##     ## ##        ##          ##    ##       ##  #### ##     ## ##     ## ##             ## 
 *    ##     ## ##     ## ##    ##  ##   ##   ##  ##   ### ##    ## ##     ## ##     ## ##        ##          ##    ##       ##   ### ##     ## ##     ## ##       ##    ## 
 *    ##     ## ##     ## ##     ## ##    ## #### ##    ##  ######   #######  ##     ## ##        ########    ##    ######## ##    ##  #######  ########  ########  ######  
 */
// markIncompeteNodes(cycle:number){
//   //clear incomplete child nodes from last time.
//   for(let treeNode of this.incompleteNodes){
//     treeNode.isIncomplete = false

//     //clear incomplete flag for all parents.
//     let nextNode = treeNode
//     for(let i = nextNode.radix.length-1; i>=0; i--){
//       let parent = this.shardTrie.layerMaps[i].get(nextNode.radix.substr(0,i))
//       if(parent == null){
//         break
//       }
//       parent.isIncomplete = false
//       nextNode = parent
//     }
//   }

//   //get the min and max non covered area
//   let shardValues = this.stateManager.shardValuesByCycle.get(cycle)

//   let consensusStartPartition = shardValues.nodeShardData.consensusStartPartition
//   let consensusEndPartition = shardValues.nodeShardData.consensusEndPartition
  
//   let shardGlobals = shardValues.shardGlobals as ShardGlobals
//   let numPartitions = shardGlobals.numPartitions

//   if(consensusStartPartition === 0 && consensusEndPartition === numPartitions - 1){
//     //nothing to mark incomplete our node covers the whole range with its consensus
//     return
//   }

//   let incompeteAddresses = []
//   if(consensusStartPartition > consensusEndPartition){
//     //consensus range like this  <CCCC---------CCC>  
//     //incompletePartition:            1       2

//     //we may have two ranges to mark
//     let incompletePartition1 = consensusEndPartition + 1 // get the start of this
//     let incompletePartition2 = consensusStartPartition - 1 //get the end of this

//     // let partition1 = shardValues.parititionShardDataMap.get(incompletePartition1)
//     // incompeteAddresses.push(partition1.homeRange.low)

//     // let partition2 = shardValues.parititionShardDataMap.get(incompletePartition2)
//     // incompeteAddresses.push(partition2.homeRange.high)

//     //flag more as incomplete!
//     for(let idx = incompletePartition1; idx<=incompletePartition2; idx++ ){
//       let partitionI = shardValues.parititionShardDataMap.get(idx)
//       incompeteAddresses.push(partitionI.homeRange.low)
//       incompeteAddresses.push(partitionI.homeRange.high)
//     }

//   } else if(consensusEndPartition > consensusStartPartition) {
//     //consensus range like this  <-----CCCCC------> or <-----------CCCCC> or <CCCCC----------->
//     //incompletePartition:            1     2           2         1                2         1
//     //   not needed:                                    x                                    x

//     //we may have two ranges to mark
//     let incompletePartition1 = consensusStartPartition - 1 //get the end of this
//     let incompletePartition2 = consensusEndPartition + 1 // get the start of this

//     let use1 = true
//     let use2 = true
//     if(consensusStartPartition === 0){
//       //incompletePartition1 = numPartitions - 1 //special case, we stil want the start
//       incompletePartition1 = numPartitions - 1
//       use1 = false
//     }
//     if(consensusEndPartition === numPartitions - 1){
//       //incompletePartition2 = 0 //special case, we stil want the start
//       incompletePartition2 = 0
//       use2 = false
//     }

//     // if(use1){
//     //   let partition1 = shardValues.parititionShardDataMap.get(incompletePartition1)
//     //   incompeteAddresses.push(partition1.homeRange.high)
//     // }
//     // if(use2){
//     //   let partition2 = shardValues.parititionShardDataMap.get(incompletePartition2)   
//     //   incompeteAddresses.push(partition2.homeRange.low)
//     // }

//     if(incompletePartition1 < incompletePartition2){
//       for(let idx = 0; idx<=incompletePartition1; idx++ ){
//         let partitionI = shardValues.parititionShardDataMap.get(idx)
//         incompeteAddresses.push(partitionI.homeRange.low)
//         incompeteAddresses.push(partitionI.homeRange.high)
//       }
//       for(let idx = incompletePartition2; idx<numPartitions; idx++ ){
//         let partitionI = shardValues.parititionShardDataMap.get(idx)
//         incompeteAddresses.push(partitionI.homeRange.low)
//         incompeteAddresses.push(partitionI.homeRange.high)
//       }
//     } else {
//       for(let idx = incompletePartition2; idx<=incompletePartition1; idx++ ){
//         let partitionI = shardValues.parititionShardDataMap.get(idx)
//         incompeteAddresses.push(partitionI.homeRange.low)
//         incompeteAddresses.push(partitionI.homeRange.high)
//       }
//     }
//   }

//   // //set new nodes as incomplete.
//   // for(let incompleteAddress of incompeteAddresses){
//   //   let radix = incompleteAddress.substr(0, this.treeMaxDepth)
//   //   let treeNode = this.shardTrie.layerMaps[radix.length].get(radix)

//   //   if(treeNode == null){
//   //     treeNode = {radix, children:[], childHashes:[], accounts:[], hash:'', accountTempMap:new Map(), updated:true, isIncomplete: false, nonSparseChildCount:0}
//   //     this.shardTrie.layerMaps[radix.length].set(radix, treeNode)
//   //   }
//   //   treeNode.updated = true
//   //   treeNode.isIncomplete = true
//   // }

//     // //set new nodes as incomplete.
//   this.incompleteNodes = []
//   let seenRadix = new Set()
//   for(let incompleteAddress of incompeteAddresses){
//     let radix = incompleteAddress.substr(0, this.treeSyncDepth)
//     let treeNode = this.shardTrie.layerMaps[radix.length].get(radix)

//     if(treeNode == null){
//       //treeNode = {radix, children:[], childHashes:[], accounts:[], hash:'', accountTempMap:new Map(), updated:true, isIncomplete: false, nonSparseChildCount:0}
//       treeNode = {radix, children:new Array(16), childHashes:new Array(16), accounts:[], hash:'', accountTempMap:new Map(), updated:true, isIncomplete: false, nonSparseChildCount:0}
//       this.shardTrie.layerMaps[radix.length].set(radix, treeNode)
//     }
//     treeNode.updated = true
//     treeNode.isIncomplete = true

//     if(seenRadix.has(radix) === false){
//       //this.incompleteNodes.push(treeNode)
//       seenRadix.add(radix)
//       //UTG!!!
//       treeNode.hash = this.hashObj(treeNode.childHashes)
//     } 

    
//   }
// }

getNonConsensusRanges(cycle:number): {low:string,high:string}[] {

  let incompleteRanges = []

  //get the min and max non covered area
  let shardValues = this.stateManager.shardValuesByCycle.get(cycle)

  let consensusStartPartition = shardValues.nodeShardData.consensusStartPartition
  let consensusEndPartition = shardValues.nodeShardData.consensusEndPartition
  
  let shardGlobals = shardValues.shardGlobals as ShardGlobals
  let numPartitions = shardGlobals.numPartitions

  if(consensusStartPartition === 0 && consensusEndPartition === numPartitions - 1){
    //nothing to mark incomplete our node covers the whole range with its consensus
    return incompleteRanges
  }

  let incompeteAddresses = []
  if(consensusStartPartition > consensusEndPartition){
    //consensus range like this  <CCCC---------CCC>  
    //incompletePartition:            1       2

    //we may have two ranges to mark
    let incompletePartition1 = consensusEndPartition + 1 // get the start of this
    let incompletePartition2 = consensusStartPartition - 1 //get the end of this

    let partition1 = shardValues.parititionShardDataMap.get(incompletePartition1)
    let partition2 = shardValues.parititionShardDataMap.get(incompletePartition2)
    
    let incompleteRange = {
      low:partition1.homeRange.low.substr(0,this.treeSyncDepth),
      high:partition2.homeRange.high.substr(0,this.treeSyncDepth)
    }
    incompleteRanges.push(incompleteRange)
    return incompleteRanges

  } else if(consensusEndPartition > consensusStartPartition) {
    //consensus range like this  <-----CCCCC------> or <-----------CCCCC> or <CCCCC----------->
    //incompletePartition:            1     2           2         1                2         1
    //   not needed:                                    x                                    x

    //we may have two ranges to mark
    let incompletePartition1 = consensusStartPartition - 1 //get the end of this
    let incompletePartition2 = consensusEndPartition + 1 // get the start of this

    //<CCCCC----------->
    //      2         1
    if(consensusStartPartition === 0){
      // = numPartitions - 1 //special case, we stil want the start
      incompletePartition1 = numPartitions - 1
      
      let partition1 = shardValues.parititionShardDataMap.get(incompletePartition2)
      let partition2 = shardValues.parititionShardDataMap.get(incompletePartition1)

      let incompleteRange = {
        low:partition1.homeRange.low.substr(0,this.treeSyncDepth),
        high:partition2.homeRange.high.substr(0,this.treeSyncDepth)
      }
      incompleteRanges.push(incompleteRange)
      return incompleteRanges
    }
    //<-----------CCCCC>
    // 2         1      
    if(consensusEndPartition === numPartitions - 1){
      //incompletePartition2 = 0 //special case, we stil want the start
      incompletePartition2 = 0

      let partition1 = shardValues.parititionShardDataMap.get(incompletePartition2)
      let partition2 = shardValues.parititionShardDataMap.get(incompletePartition1)

      let incompleteRange = {
        low:partition1.homeRange.low.substr(0,this.treeSyncDepth),
        high:partition2.homeRange.high.substr(0,this.treeSyncDepth)
      }
      incompleteRanges.push(incompleteRange)
      return incompleteRanges
    }

    //<-----CCCCC------>
    // 0   1     2    n-1  
    let partition1 = shardValues.parititionShardDataMap.get(0)
    let partition2 = shardValues.parititionShardDataMap.get(incompletePartition1)
    let incompleteRange = {
      low:partition1.homeRange.low.substr(0,this.treeSyncDepth),
      high:partition2.homeRange.high.substr(0,this.treeSyncDepth)
    }

    let partition1b = shardValues.parititionShardDataMap.get(incompletePartition2)
    let partition2b = shardValues.parititionShardDataMap.get(numPartitions - 1)
    let incompleteRangeB= {
      low:partition1b.homeRange.low.substr(0,this.treeSyncDepth),
      high:partition2b.homeRange.high.substr(0,this.treeSyncDepth)
    }

    incompleteRanges.push(incompleteRange)
    incompleteRanges.push(incompleteRangeB)
    return incompleteRanges
  }


  return incompleteRanges
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
  diffConsenus(consensusArray:RadixAndHash[], mapB: Map<string, HashTrieNode>) : {radix:string, hash:string}[] {

    if(consensusArray == null){
      this.statemanager_fatal('diffConsenus: consensusArray == null', 'diffConsenus: consensusArray == null')
      return []
    }

    //map 
    let toFix = []
    for(let value of consensusArray){
      if(mapB == null){
        toFix.push(value)
        continue
      }

      let valueB =  mapB.get(value.radix)
      if(valueB == null){
        //missing
        toFix.push(value)
        continue
      }
      if(valueB.hash !== value.hash){
        //different hash
        toFix.push(value)
      }
    }
    return toFix
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
  computeCoverage(cycle:number){
    let hashTrieSyncConsensus = this.hashTrieSyncConsensusByCycle.get(cycle)

    let coverageMap:Map<string, HashTrieRadixCoverage> = new Map() //map of sync radix to n

    hashTrieSyncConsensus.coverageMap = coverageMap

    //let nodeUsage = new Map()
    for(let radixHash of hashTrieSyncConsensus.radixHashVotes.keys() ){
      let coverage = coverageMap.get(radixHash)
      if(coverage == null){
        let votes = hashTrieSyncConsensus.radixHashVotes.get(radixHash)
        let bestVote = votes.allVotes.get(votes.bestHash)
        let potentialNodes = bestVote.voters
        let node = potentialNodes[0]
        coverageMap.set(radixHash, {firstChoice:node, fullList: bestVote.voters, refuted:new Set()})
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
  getNodeForQuery(radix:string, cycle:number, nextNode:boolean = false){
    let hashTrieSyncConsensus = this.hashTrieSyncConsensusByCycle.get(cycle)
    let parentRadix = radix.substr(0, this.treeSyncDepth)

    let coverageEntry = hashTrieSyncConsensus.coverageMap.get(parentRadix)

    if(coverageEntry == null || coverageEntry.firstChoice == null){
      this.fatalLogger(`getNodeForQuery null ${coverageEntry == null} ${coverageEntry?.firstChoice == null}`,`getNodeForQuery null ${coverageEntry == null} ${coverageEntry?.firstChoice == null}`)
    }

    if(nextNode === true){
      coverageEntry.refuted.add(coverageEntry.firstChoice.id)
      for(let i=0; i<coverageEntry.fullList.length; i++){
        let node = coverageEntry.fullList[i]
        if(node == null || coverageEntry.refuted.has(node.id)){
          continue
        }
        coverageEntry.firstChoice = node
        return coverageEntry.firstChoice
      }
      
    } else {
      return coverageEntry.firstChoice
    }
  }

  async getChildrenOf(radixHashEntries:RadixAndHash[], cycle:number) : Promise<RadixAndHash[]> {
    let result:HashTrieResp 
    let nodeHashes: RadixAndHash[] = []
    let requestMap:Map<Shardus.Node, HashTrieReq> = new Map()
    for(let radixHash of radixHashEntries ){
      let node = this.getNodeForQuery(radixHash.radix, cycle)
      let existingRequest = requestMap.get(node)
      if(existingRequest == null){
        existingRequest = {radixList:[]}
        requestMap.set(node, existingRequest)
      }
      if(node == null){
        this.statemanager_fatal('getChildrenOf node null', 'getChildrenOf node null')
        continue
      }
      existingRequest.radixList.push(radixHash.radix)
    }
    for(let [key, value] of requestMap){
      try{
        result = await this.p2p.ask(key, 'get_trie_hashes', value)
        if(result != null && result.nodeHashes != null){
          nodeHashes = nodeHashes.concat(result.nodeHashes)
        } //else retry?        
      } catch (error) {
        this.statemanager_fatal('getChildrenOf failed', `getChildrenOf failed: ` + error.name + ': ' + error.message + ' at ' + error.stack)
      }
    }
    if(nodeHashes.length > 0){
      nestedCountersInstance.countEvent(`accountPatcher`, `got nodeHashes`, nodeHashes.length) 
    }

    return nodeHashes
  }

  async getChildAccountHashes(radixHashEntries:RadixAndHash[], cycle:number) : Promise<RadixAndChildHashes[]> {
    let result:HashTrieAccountsResp
    let nodeChildHashes: RadixAndChildHashes[] = []
    let allHashes: AccountIDAndHash[] = []
    let requestMap:Map<Shardus.Node, HashTrieReq> = new Map()
    for(let radixHash of radixHashEntries ){
      let node = this.getNodeForQuery(radixHash.radix, cycle)
      let existingRequest = requestMap.get(node)
      if(existingRequest == null){
        existingRequest = {radixList:[]}
        requestMap.set(node, existingRequest)
      }
      if(node == null){
        this.statemanager_fatal('getChildAccountHashes node null', 'getChildAccountHashes node null ')
        continue
      }
      existingRequest.radixList.push(radixHash.radix)
    }
    for(let [key, value] of requestMap){
      try{
        result = await this.p2p.ask(key, 'get_trie_accountHashes', value) 
        if(result != null && result.nodeChildHashes != null){
          nodeChildHashes = nodeChildHashes.concat(result.nodeChildHashes)
          // for(let childHashes of result.nodeChildHashes){
          //   allHashes = allHashes.concat(childHashes.childAccounts)
          // }
        } //else retry?        
      } catch (error) {
        this.statemanager_fatal('getChildAccountHashes failed', `getChildAccountHashes failed: ` + error.name + ': ' + error.message + ' at ' + error.stack)

      }
    }
    if(nodeChildHashes.length > 0){
      nestedCountersInstance.countEvent(`accountPatcher`, `got nodeChildHashes`, nodeChildHashes.length) 
    }

    return nodeChildHashes
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
  isInSync(cycle){
    let hashTrieSyncConsensus = this.hashTrieSyncConsensusByCycle.get(cycle)

    if(hashTrieSyncConsensus == null){
      return true
    }
    //let oosRadix = []
    //get our list of covered radix values for cycle X!!!
    //let inSync = true
    for(let radix of hashTrieSyncConsensus.radixHashVotes.keys()){
      let votesMap = hashTrieSyncConsensus.radixHashVotes.get(radix)
      let ourTrieNode = this.shardTrie.layerMaps[this.treeSyncDepth].get(radix)

      //if we dont have the node we may have missed an account completely!
      if(ourTrieNode == null){
        return false
      }

      //TODO should not have to re compute this here!!
      ourTrieNode.hash = this.crypto.hash(ourTrieNode.childHashes)

      if(ourTrieNode.hash != votesMap.bestHash){
        //inSync = false
        //oosRadix.push()
        return false
      }
    }
    //todo what about situation where we do not have enough votes??
    //todo?? more utility / get list of oos radix
    return true// {inSync, }
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
  async findBadAccounts(cycle:number){
    let badAccounts:AccountIDAndHash[] = []
    let hashesPerLevel = Array(this.treeMaxDepth+1).fill(0)
    let checkedKeysPerLevel = Array(this.treeMaxDepth)
    let badHashesPerLevel = Array(this.treeMaxDepth+1).fill(0)
    let requestedKeysPerLevel = Array(this.treeMaxDepth+1).fill(0)

    let level = this.treeSyncDepth

    let badLayerMap = this.shardTrie.layerMaps[level]

    let goodVotes:RadixAndHash[] = []
    let hashTrieSyncConsensus = this.hashTrieSyncConsensusByCycle.get(cycle)
    for(let radix of hashTrieSyncConsensus.radixHashVotes.keys()){
      let votesMap = hashTrieSyncConsensus.radixHashVotes.get(radix)
      goodVotes.push({radix, hash: votesMap.bestHash})
    }

    let toFix = this.diffConsenus(goodVotes, badLayerMap)

    if(logFlags.debug){
      toFix.sort(this.sortByRadix)
      this.statemanager_fatal('debug findBadAccounts',`debug findBadAccounts ${cycle}: ${utils.stringifyReduce(toFix)}`)
    }

    //record some debug info
    badHashesPerLevel[level] = toFix.length 
    checkedKeysPerLevel[level] = toFix.map(x => x.radix)
    requestedKeysPerLevel[level] = goodVotes.length
    hashesPerLevel[level] = goodVotes.length

    this.computeCoverage(cycle)

    //refine our query until we get to the lowest level
    while(level < this.treeMaxDepth && toFix.length > 0){
      level++
      badLayerMap = this.shardTrie.layerMaps[level]
      let childrenToDiff = await this.getChildrenOf(toFix, cycle) 

      toFix = this.diffConsenus(childrenToDiff, badLayerMap)
      //record some debug info
      badHashesPerLevel[level] = toFix.length
      checkedKeysPerLevel[level] = toFix.map(x => x.radix)
      requestedKeysPerLevel[level] = childrenToDiff.length
      hashesPerLevel[level] = childrenToDiff.length // badLayerMap.size ...badLayerMap could be null!
    }

    //get bad accounts
    let radixAndChildHashes = await this.getChildAccountHashes(toFix, cycle)

    let accountHashesChecked = 0
    for(let radixAndChildHash of radixAndChildHashes){
      accountHashesChecked += radixAndChildHash.childAccounts.length

      let badTreeNode = badLayerMap.get(radixAndChildHash.radix)
      if(badTreeNode != null){
        let accMap = new Map()
        for(let i=0; i<badTreeNode.accounts.length; i++ ){
          accMap.set(badTreeNode.accounts[i].accountID,badTreeNode.accounts[i])
        }

        for(let i=0; i<radixAndChildHash.childAccounts.length; i++ ){
          let potentalGoodAcc = radixAndChildHash.childAccounts[i]
          let potentalBadAcc = accMap.get(potentalGoodAcc.accountID)
          //is the account missing or wrong hash?
          if(potentalBadAcc != null){
            if(potentalBadAcc.hash != potentalGoodAcc.hash){
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
    return {badAccounts, hashesPerLevel, checkedKeysPerLevel, requestedKeysPerLevel, badHashesPerLevel, accountHashesChecked}
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
  updateAccountHash(accountID:string, hash:string){

    //todo do we need to look at cycle or timestamp and have a future vs. next queue?
    if(this.debug_ignoreUpdates){
      this.statemanager_fatal( `patcher ignored: tx`, `patcher ignored: ${accountID} hash:${hash}`)
      return
    }

    let accountData = {accountID, hash}
    this.accountUpdateQueue.push(accountData)
  }


  removeAccountHash(accountID:string){

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

  async broadcastSyncHashes(cycle){
    let syncLayer = this.shardTrie.layerMaps[this.treeSyncDepth]

    let shardGlobals = this.stateManager.currentCycleShardData.shardGlobals

    let messageToNodeMap:Map<string, {node: Shardus.Node, message: HashTrieSyncTell}> = new Map()

    let radixUsed: Map<string, Set<string>> = new Map()

    let nonConsensusRanges = this.getNonConsensusRanges(cycle)
    let hasNonConsensusRange = false
    for(let treeNode of syncLayer.values()){

      hasNonConsensusRange = false
      for(let range of nonConsensusRanges){
        if(treeNode.radix >= range.low && treeNode.radix <= range.high){
          hasNonConsensusRange = true
        }
      }
      if(hasNonConsensusRange){
        continue
      }

      //if(treeNode.isIncomplete === false){
        let partitionRange = ShardFunctions.getPartitionRangeFromRadix(shardGlobals, treeNode.radix)
        for(let i=partitionRange.low; i<=partitionRange.high; i++){
          let shardInfo = this.stateManager.currentCycleShardData.parititionShardDataMap.get(i)
          for(let [key, value] of Object.entries(shardInfo.coveredBy)){
            let messagePair = messageToNodeMap.get(value.id)
            if(messagePair == null){
              messagePair = {node: value, message: {cycle, nodeHashes: []}}
              messageToNodeMap.set(value.id, messagePair)
            }
            // todo done send duplicate node hashes to the same node?

            let radixSeenSet = radixUsed.get(value.id)
            if(radixSeenSet == null){
              radixSeenSet = new Set()
              radixUsed.set(value.id, radixSeenSet)
            }
            if(radixSeenSet.has(treeNode.radix) === false){
              //extra safety step! todo remove for perf.
              treeNode.hash = this.hashObj(treeNode.childHashes)
              messagePair.message.nodeHashes.push({radix:treeNode.radix, hash: treeNode.hash})
              radixSeenSet.add(treeNode.radix)
            }
          }          
        }

      //}
    }
    
    let promises = []
    for(let messageEntry of messageToNodeMap.values()){
      let promise = this.p2p.tell([messageEntry.node], 'sync_trie_hashes', messageEntry.message)
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
  async updateTrieAndBroadCast(cycle){

    //calculate sync levels!! 
    let shardValues = this.stateManager.shardValuesByCycle.get(cycle)
    let shardGlobals = shardValues.shardGlobals as ShardGlobals

    let minHashesPerRange = 4
    // y = floor(log16((minHashesPerRange * max(1, x/consensusRange   ))))
    let syncDepthRaw = Math.log(minHashesPerRange * Math.max(1, shardGlobals.numPartitions / (shardGlobals.consensusRadius * 2 + 1))) / Math.log(16)
    syncDepthRaw = Math.max(1, syncDepthRaw) // at least 1
    let newSyncDepth = Math.ceil(syncDepthRaw)
    
    if(this.treeSyncDepth != newSyncDepth){ //todo add this in to prevent size flipflop..(better: some deadspace)  && newSyncDepth > this.treeSyncDepth){
      let newMaxDepth = newSyncDepth + 3  //todo the "+3" should be based on total number of stored accounts pre node (in a consensed way, needs to be on cycle chain)
      //add more maps if needed  (+1 because we have a map level 0)
      while(this.shardTrie.layerMaps.length < newMaxDepth + 1){
        this.shardTrie.layerMaps.push(new Map())
      }  

      //detach all accounts.

      let currentLeafMap = this.shardTrie.layerMaps[this.treeMaxDepth]  

      //put all accounts into queue to rebuild Tree!
      for(let treeNode of currentLeafMap.values()){
        if(treeNode.accounts != null){
          for(let account of treeNode.accounts){
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

          nestedCountersInstance.countEvent(`accountPatcher`, `updateTrieAndBroadCast: ok account list?`)   
        } else{
          nestedCountersInstance.countEvent(`accountPatcher`, `updateTrieAndBroadCast: null account list?`)
        }
      }

      //better to just wipe out old parent nodes!
      for(let idx = 0; idx < newMaxDepth; idx++ ) {
        this.shardTrie.layerMaps[idx].clear() 
      }  
      
      if(newMaxDepth < this.treeMaxDepth){
        //cant get here, but consider deleting layers out of the map
        nestedCountersInstance.countEvent(`accountPatcher`, `max depth decrease oldMaxDepth:${this.treeMaxDepth} maxDepth :${newMaxDepth}`)
      } else {
        nestedCountersInstance.countEvent(`accountPatcher`, `max depth increase oldMaxDepth:${this.treeMaxDepth} maxDepth :${newMaxDepth}`)
      }

      this.treeSyncDepth = newSyncDepth
      this.treeMaxDepth =  newMaxDepth
    
    }


    nestedCountersInstance.countEvent(`accountPatcher`, ` syncDpeth:${this.treeSyncDepth} maxDepth :${this.treeMaxDepth}`)

    let updateStats = this.upateShardTrie(cycle)

    nestedCountersInstance.countEvent(`accountPatcher`, `totalAccountsHashed`, updateStats.totalAccountsHashed)

    //broadcast sync 
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
  //TODO save off last stats and put them on an endpoint for debugging/confirmation
  async testAndPatchAccounts(cycle){

    // let updateStats = this.upateShardTrie(cycle)

    // nestedCountersInstance.countEvent(`accountPatcher`, `totalAccountsHashed`, updateStats.totalAccountsHashed)

    if(logFlags.debug){
      
      this.statemanager_fatal('debug shardTrie',`temp shardTrie ${cycle}: ${utils.stringifyReduce(this.shardTrie.layerMaps[0].values().next().value)}`)

      let hashTrieSyncConsensus = this.hashTrieSyncConsensusByCycle.get(cycle)

      let debug = []
      for(let [key,value] of hashTrieSyncConsensus.radixHashVotes){
        debug.push({radix:key , hash: value.bestHash, votes: value.bestVotes})
      }
      debug.sort(this.sortByRadix)
      this.statemanager_fatal('debug shardTrie',`temp shardTrie votes ${cycle}: ${utils.stringifyReduce(debug)}`)
    }

    if(this.isInSync(cycle) === false){

      let results = await this.findBadAccounts(cycle)
      nestedCountersInstance.countEvent(`accountPatcher`, `badAccounts ${cycle} `, results.badAccounts.length)
      nestedCountersInstance.countEvent(`accountPatcher`, `accountHashesChecked ${cycle}`, results.accountHashesChecked)

      // local test patches.//debug only feature

      //request data for the list of bad accounts then update. this can live in account repair?
      
      let wrappedDataList = await this.getAccountRepairData(cycle, results.badAccounts )

      this.statemanager_fatal('isInSync = false',`bad accounts cycle:${cycle} bad:${results.badAccounts.length} received:${wrappedDataList} details: ${utils.stringifyReduce(results.badAccounts)}`)
      this.statemanager_fatal('isInSync = false',`isInSync = false ${cycle}: `)
      //this.statemanager_fatal('debug shardTrie',`temp shardTrie ${cycle}: ${utils.stringifyReduce(this.shardTrie.layerMaps[0].values())}`)

      //return //todo dont want to test full stack yet
      
      //need to validate TS we are trying to write
      //it is possible the majority voters could send us account data that is older than what we have.
      //todo must sort out if we can go backwards...  (I had dropped some pre validation earlier, but need to rethink that)
      let wrappedDataListFiltered:Shardus.WrappedData[] = []
      let noChange = new Set()
      let updateTooOld = new Set()
      for(let wrappedData of wrappedDataList){
        if (this.stateManager.accountCache.hasAccount(wrappedData.accountId)) {
          let accountMemData: AccountHashCache = this.stateManager.accountCache.getAccountHash(wrappedData.accountId)
          if (wrappedData.timestamp < accountMemData.t) {
            updateTooOld.add(wrappedData.accountId)
            nestedCountersInstance.countEvent('accountPatcher', `checkAndSetAccountData updateTooOld c:${cycle}`)
            this.statemanager_fatal('checkAndSetAccountData updateTooOld',`checkAndSetAccountData updateTooOld ${cycle}: acc:${utils.stringifyReduce(wrappedData.accountId)} updateTS:${wrappedData.timestamp} updateHash:${utils.stringifyReduce(wrappedData.stateId)}  cacheTS:${accountMemData.t} cacheHash:${utils.stringifyReduce(accountMemData.h)}`)
            continue
          }
          if(wrappedData.timestamp === accountMemData.t) {
            noChange.add(wrappedData.accountId)
            nestedCountersInstance.countEvent('accountPatcher', `checkAndSetAccountData updateSameTS c:${cycle}`)
            continue
          }
          //we can proceed with the update
          wrappedDataListFiltered.push(wrappedData)
        } else {
          //dont have a cache entry so take the update
          wrappedDataListFiltered.push(wrappedData)
        }
      }




      //do some work so ave the data  
      let failedHashes = await this.stateManager.checkAndSetAccountData(wrappedDataListFiltered, `testAndPatchAccounts`, false)

      if(failedHashes.length != 0){
        nestedCountersInstance.countEvent('accountPatcher', 'checkAndSetAccountData failed hashes', failedHashes.length)
        this.statemanager_fatal('isInSync = false, failed hashes',`isInSync = false cycle:${cycle}:  failed hashes:${failedHashes.length}`)
      }
      nestedCountersInstance.countEvent('accountPatcher', 'writeCombinedAccountDataToBackups', Math.max(0,wrappedDataListFiltered.length - failedHashes.length))

      //This extracts accounts that have failed hashes but I forgot writeCombinedAccountDataToBackups does that already
      //let failedHashesSet = new Set(failedHashes)
      // let wrappedDataUpdated = []
      // for(let wrappedData of wrappedDataListFiltered){
      //   if(failedHashesSet.has(wrappedData.accountId )){
      //     continue
      //   }
      //   wrappedDataUpdated.push(wrappedData)
      // }

      await this.stateManager.writeCombinedAccountDataToBackups(wrappedDataListFiltered, failedHashes)

      //apply repair account data and update shard trie

      // get list of accounts that were fixed. (should happen for free by account cache system)
      // for(let wrappedData of wrappedDataList){
      //   if(failedHashesSet.has(wrappedData.accountId) === false){

      //     //need good way to update trie..  just insert and let it happen next round!
      //     this.updateAccountHash(wrappedData.accountId, wrappedData.stateId)
      //   }
      // }

      //check again if we are in sync

    } else {
      nestedCountersInstance.countEvent(`accountPatcher`, `inSync`)
    }

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
  async getAccountRepairData(cycle:number, badAccounts:AccountIDAndHash[] ): Promise<Shardus.WrappedData[]> {
    //pick which nodes to ask! /    //build up requests
    let nodesBySyncRadix:Map<string, {node:Shardus.Node, request:{cycle, accounts:AccountIDAndHash[]} }> = new Map()
    for(let accountEntry of badAccounts){
      let syncRadix = accountEntry.accountID.substr(0, this.treeSyncDepth)
      let requestEntry = nodesBySyncRadix.get(syncRadix)
      if(requestEntry == null){
        //minor layer of security, we will ask a different node for the account than the one that gave us the hash
        let nodeToAsk = this.getNodeForQuery(accountEntry.accountID, cycle, true) 

        requestEntry = {node:nodeToAsk, request:{cycle, accounts:[]}}
        nodesBySyncRadix.set(syncRadix, requestEntry)
      } 
      requestEntry.request.accounts.push(accountEntry)
    }

    let promises = []
    for(let requestEntry of nodesBySyncRadix.values()){
      // look at responses.. we may not get all accounts back.
      let promise = this.p2p.ask(requestEntry.node, 'get_account_data_by_hashes', requestEntry.request)
      promises.push(promise)

    }

    let wrappedDataList:Shardus.WrappedData[] = []

    let results = await Promise.all(promises)
    for(let result of results){
      //HashTrieAccountDataResponse
      if(result != null && result.accounts != null && result.accounts.length > 0){
        wrappedDataList = wrappedDataList.concat(result.accounts)        
      }
    }

    return wrappedDataList
  }


//how about marking our incomplete areas so that sharding works!!
// find min and max non covered partition
// then get the min and max values. and flag for non edge partitions .  partition 0 and partition max dont need flagging.


}

export default AccountPatcher
