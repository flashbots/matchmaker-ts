import { JsonRpcProvider, keccak256 } from 'ethers'
import { Mutex } from "async-mutex"

// lib
import Matchmaker from '..'
import { ShareBundleParams, PendingShareTransaction } from '../api'
import { getProvider, initExample } from './lib/helpers'
import { sendTx, setupTxExample } from './lib/sendTx'

/**
 * Generate a transaction to backrun a pending mev-share transaction and send it to mev-share.
 */
const sendTestBackrunBundle = async (provider: JsonRpcProvider, pendingTx: PendingShareTransaction, matchmaker: Matchmaker, targetBlock: number) => {
    // send ofa bundle w/ 42 gwei priority fee
    let {tx, wallet} = (await setupTxExample(provider, BigInt(1e9) * BigInt(42), "im backrunniiiiing"))
    tx = {
        ...tx,
        nonce: tx.nonce ? tx.nonce + 1 : undefined,
    }
    const backruns = [
        [await wallet.signTransaction(tx)]
    ]
    const shareTxs = [pendingTx.txHash]
    const params: ShareBundleParams = {
        targetBlock,
        backruns,
        shareTxs,
    }
    console.debug(JSON.stringify(params))
    const backrunRes = await matchmaker.sendShareBundle(params)
    console.log("backrun result", backrunRes)
    return {
        backruns,
        backrunRes,
    }
}

/** Async handler which backruns an mev-share tx with another basic example tx. */
const handleBackrun = async (
    pendingTx: PendingShareTransaction,
    provider: JsonRpcProvider,
    matchmaker: Matchmaker,
    pendingMutex: Mutex,
) => {
    console.log("pending tx", pendingTx)
    let targetBlock = await provider.getBlockNumber() + 2
    let { backruns } = await sendTestBackrunBundle(provider, pendingTx, matchmaker, targetBlock)

    // block thread until target block is verified
    while (await provider.getBlockNumber() < targetBlock) {
        await new Promise(resolve => setTimeout(resolve, 2000))
    }

    // check for inclusion of backrun tx in target block
    const backrunTxHash = keccak256(backruns[0][0])
    const receipt = await provider.getTransactionReceipt(backrunTxHash)
    if (receipt?.status === 1) {
        console.log("backrun tx included!")
        // release mutex so the main thread can exit
        pendingMutex.release()
    } else {
        console.warn(`tx ${backrunTxHash} not included in block ${targetBlock}`)
    }
}

/**
 * Sends a tx on every block and backruns it with a simple example tx.
 *
 * Continues until we land a backrun, then exits.
 */
const main = async () => {
    const provider = getProvider()
    const {matchmaker} = await initExample(provider)

    // used for blocking this thread until the handler is done processing
    const pendingMutex = new Mutex()
    
    // listen for txs
    const txHandler = matchmaker.listenForShareTransactions(pendingTx => handleBackrun(pendingTx, provider, matchmaker, pendingMutex))
    console.log("listening for transactions...")

    await pendingMutex.acquire()
    // send a tx that we can backrun on every block
    // tx will be backrun independently by the `handleBackrun` callback
    const blockHandler = await provider.on("block", async (_) => {
        await sendTx(provider, {logs: true, contractAddress: true, calldata: true, functionSelector: true})
    })

    // will block until the handler releases the mutex
    await pendingMutex.acquire()
    pendingMutex.release()

    // stop listening for txs
    txHandler.close()
    await blockHandler.removeAllListeners()
    console.log("block listener relieved of duty. waiting for handler threads to finish...")
}

main()
