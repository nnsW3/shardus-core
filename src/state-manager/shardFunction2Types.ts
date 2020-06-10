import Shardus = require('../shardus/shardus-types');

type ShardGlobals2 = {
    /**
     * number of active nodes
     */
    numActiveNodes: number;
    /**
     * number of nodes per consesus group
     */
    nodesPerConsenusGroup: number;
    /**
     * number of partitions
     */
    numPartitions: number;
    /**
     * default number of partitions that are visible to a node (ege or consensus)
     */
    numVisiblePartitions: number;
    /**
     * consenus radius (number of nodes to each side of us that hold consensus data)
     */
    consensusRadius: number;
    /**
     * Address range to look left and right (4 byte numeric)
     */
    nodeLookRange: number;
    /**
     * End address in numeric form (4 bytes)
     */
    endAddr: number;
  };
  /**
  * global shard values
  */
type ShardInfo2 = {
    /**
     * address used in calculation
     */
    address: string;
    /**
     * homeNodes list of NodeShardData2
     */
    homeNodes: NodeShardData2[];
    /**
     * numeric address prefix
     */
    addressPrefix: number;
    /**
     * number of partitions
     */
    addressPrefixHex: string;
    /**
     * the home partition
     */
    homePartition: number;
    /**
     * consenus radius (number of nodes to each side of us that hold consensus data)
     */
    homeRange: AddressRange2;
    /**
     * the nodes that cover us for consenus.
     */
    coveredBy: {
        [address: string]: Shardus.Node;
    };
    /**
     * the nodes that cover us for storage.
     */
    storedBy: {
        [address: string]: Shardus.Node;
    };
  };
  /**
  * Data for a StoredPartition2
  */
  type StoredPartition2 = {
    /**
     * range for the home partition
     */
    homeRange: AddressRange2;
    /**
     * is the range split
     */
    rangeIsSplit: boolean;
    /**
     * Starting index
     */
    partitionStart: number;
    /**
     * End index
     */
    partitionEnd: number;
    /**
     * The user's age.
     */
    partitionStart1: number;
    /**
     * End index
     */
    partitionEnd1: number;
    /**
     * The user's age.
     */
    partitionStart2: number;
    /**
     * End index
     */
    partitionEnd2: number;
    partitionRangeVector: {
        start: number;
        dist: number;
        end: number;
    };
    /**
     * For debug: shardGlobals.nodesPerConsenusGroup
     */
    x?: number;
    /**
     * For debug: homePartition
     */
    n?: number;
    partitionRange: AddressRange2;
    partitionRange2: AddressRange2;
    /**
     * Number of partitions covered by this node
     */
    partitionsCovered?: number;
  };
  /**
  * shard data for a node
  */
  type NodeShardData2 = {
    /**
     * our node
     */
    node: Shardus.Node;
    /**
     * numeric address prefix
     */
    nodeAddressNum: number;
    /**
     * number of partitions
     */
    homePartition: number;
    /**
     * the home partition
     */
    centeredAddress: number;
    /**
     * the home partition
     */
    ourNodeIndex: number;
    consensusStartPartition: number;
    consensusEndPartition: number;
    /**
     * have we calculated extended data yet
     */
    extendedData: boolean;
    /**
     * extended data below here
     */
    needsUpdateToFullConsensusGroup: boolean;
    /**
     * consenus radius (number of nodes to each side of us that hold consensus data)
    property {Map<string,Node>} coveredBy the nodes that cover us for consenus // removed not sure this goes here
     */
    storedPartitions: StoredPartition2;
    nodeThatStoreOurParition: Shardus.Node[];
    nodeThatStoreOurParitionFull: Shardus.Node[];
    consensusNodeForOurNode: Shardus.Node[];
    consensusNodeForOurNodeFull: Shardus.Node[];
    edgeNodes: Shardus.Node[];
    c2NodeForOurNode: Shardus.Node[];
    outOfDefaultRangeNodes: Shardus.Node[];
    patchedOnNodes: Shardus.Node[];
  };
  /**
  * A range of addresses
  */
  type AddressRange2 = {
    /**
     * the partition
     */
    partition: number;
    /**
     * End index
     */
    p_low: number;
    /**
     * The user's age.
     */
    p_high: number;
    partitionEnd: number;
    /**
     * Start address in numeric form (4 bytes)
     */
    startAddr: number;
    /**
     * End address in numeric form (4 bytes)
     */
    endAddr: number;
    /**
     * End address in 64 char string
     */
    low: string;
    /**
     * End address in 64 char string
     */
    high: string;
  };
  /**
  * A range of addresses
  */
  // export interface BasicAddressRange2  {
  //   /**
  //    * Start address in numeric form (4 bytes)
  //    */
  //   startAddr: number;
  //   /**
  //    * End address in numeric form (4 bytes)
  //    */
  //   endAddr: number;
  //   /**
  //    * End address in 64 char string
  //    */
  //   low: string;
  //   /**
  //    * End address in 64 char string
  //    */
  //   high: string;
  // };
  
  type HomeNodeSummary2 = {
    edge: string[];
    consensus: string[];
    storedFull: string[];
    noExtendedData? : boolean;
  };
  
  // type SimpleResponse = {
  //   success: boolean;
  //   reason: string;
  // };
  
  type ParititionShardDataMap2 = Map<number, ShardInfo2>
  type NodeShardDataMap2 = Map<string, NodeShardData2>
  type MergeResults2 = { s1:number, e1:number, s2:number, e2:number, split: boolean, changed: boolean }
  

interface BasicAddressRange2  {
    /**
     * Start address in numeric form (4 bytes)
     */
    startAddr: number;
    /**
     * End address in numeric form (4 bytes)
     */
    endAddr: number;
    /**
     * End address in 64 char string
     */
    low: string;
    /**
     * End address in 64 char string
     */
    high: string;
  };

export {ShardGlobals2, ShardInfo2, StoredPartition2, NodeShardData2, AddressRange2,  HomeNodeSummary2, ParititionShardDataMap2, NodeShardDataMap2, MergeResults2, BasicAddressRange2 }