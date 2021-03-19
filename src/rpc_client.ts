import { Market } from '@project-serum/serum'
import { AccountInfo, Commitment, PublicKey } from '@solana/web3.js'
import fetch from 'node-fetch'
import AbortController from 'abort-controller'
import { PassThrough } from 'stream'
import WebSocket from 'ws'
import { executeAndRetry } from './helpers'
import { logger } from './logger'

// simple solana RPC client
export class RPCClient {
  constructor(private readonly _options: { readonly nodeEndpoint: string }) {}

  public async *streamAccountsNotification(market: Market, marketName: string): AsyncIterable<AccountsNotification> {
    const wssEndpoint = new URL(this._options.nodeEndpoint)
    wssEndpoint.protocol = 'wss'

    const notificationsStream = new PassThrough({
      objectMode: true,
      highWaterMark: 8096
    })

    var accountsNotifications = new AccountsChangeNotifications(market, {
      nodeWssEndpoint: wssEndpoint.toString(),
      marketName,
      commitment: 'confirmed'
    })

    accountsNotifications.onAccountsChange = (notification) => {
      notificationsStream.write(notification)
    }

    try {
      for await (const notification of notificationsStream) {
        yield notification as AccountsNotification
      }
    } finally {
      accountsNotifications.dispose()
    }
  }

  async getAccountInfo(publicKey: PublicKey, commitment?: Commitment): Promise<AccountInfo<Buffer> | null> {
    const { result } = await executeAndRetry(
      async () => this._getAccountInfoRPCResponseRaw(publicKey.toBase58(), commitment),
      { maxRetries: 10 }
    )

    if (result.value === null) {
      return null
    }

    const accountInfo: AccountInfo<Buffer> = {
      owner: new PublicKey(result.value.owner),
      data: Buffer.from(result.value.data[0], 'base64'),
      rentEpoch: result.value.rentEpoch,
      lamports: result.value.lamports,
      executable: result.value.executable
    }

    return accountInfo
  }

  private async _getAccountInfoRPCResponseRaw(publicKey: string, commitment?: string) {
    const controller = new AbortController()

    const requestTimeout = setTimeout(() => {
      controller.abort()
    }, 3000)

    try {
      const response = await fetch(this._options.nodeEndpoint, {
        signal: controller.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [
            publicKey,
            {
              encoding: 'base64',
              commitment
            }
          ]
        })
      })

      if (!response.ok) {
        let errorText = ''
        try {
          errorText += await response.text()
        } catch {}
        throw new Error(errorText)
      }

      const data = (await response.json()) as {
        result: {
          context: {
            slot: number
          }
          value: {
            data: [string, string]
            executable: boolean
            lamports: number
            owner: string
            rentEpoch: number
          } | null
        }
      }

      return data
    } finally {
      clearTimeout(requestTimeout)
    }
  }
}

// this helper class handles RPC subscriptions to seprate DEX accounts (bids, asks & event queue)
// and provide notification in synchronized fashion, meaning  we get at most one notification per slot
// with accounts data that changed in that slot
//
// This way we always process accounts updates in the same order as single update
// otherwise we would end up processing eventsQueue changes before bids/asks if that would be
// the order of accountNotification messages returned by the server which would be wrong
//as we'd end up with 'fill' message published before 'open' message for example
//
// TODO: when https://github.com/solana-labs/solana/issues/12237 is implemented
// we'll be able to subscribe to multiple accounts at once

class AccountsChangeNotifications {
  private _currentSlot: number | undefined = undefined
  private _state: 'PRISTINE' | 'PENDING' | 'PUBLISHED' = 'PRISTINE'
  private _accountsData!: AccountsData
  private _slotStartTimestamp: number | undefined = undefined
  private _publishTID: NodeJS.Timer | undefined = undefined
  private _pingTID: NodeJS.Timer | undefined = undefined

  public onAccountsChange: (notification: AccountsNotification) => void = () => {}
  private _disposed: boolean = false

  private readonly _accountsMeta: {
    readonly name: AccountName
    readonly reqId: number
    readonly address: string
  }[]

  private _wsSubsMeta: Map<number, AccountName> = new Map()

  constructor(
    market: Market,
    private readonly _options: {
      readonly nodeWssEndpoint: string
      readonly marketName: string
      readonly commitment: string
    }
  ) {
    this._accountsMeta = [
      {
        name: 'bids',
        reqId: 1000,
        address: market.bidsAddress.toBase58()
      },
      {
        name: 'asks',
        reqId: 2000,
        address: market.asksAddress.toBase58()
      },
      {
        name: 'eventQueue',
        reqId: 3000,
        address: (market as any)._decoded.eventQueue.toBase58()
      }
    ]

    this._resetAccountData()
    this._connectAndStreamData()
  }

  public dispose() {
    this._clearTimers()
    this._disposed = true
  }

  private _connectAndStreamData() {
    if (this._disposed) {
      return
    }

    const ws = new WebSocket(this._options.nodeWssEndpoint)
    ws.onopen = () => {
      this._subscribeToAccountsNotifications(ws)
      this._sendPeriodicPings(ws)
    }

    ws.onmessage = (event) => {
      if (this._disposed) {
        return
      }
      const message = JSON.parse(event.data as any)

      if (message.error !== undefined) {
        logger.log('warn', `Received RPC WebSocket error message: ${event.data}`, { market: this._options.marketName })
        this._restartConnection(ws)

        return
      }

      if (message.result !== undefined) {
        const matchingAccount = this._accountsMeta.find((a) => a.reqId === message.id)
        if (matchingAccount !== undefined) {
          this._wsSubsMeta.set(message.result, matchingAccount.name)
        }

        return
      }

      if (message.method === 'accountNotification') {
        const subMessage = message as {
          method: 'accountNotification'
          params: {
            result: {
              context: {
                slot: number
              }
              value: {
                data: [string, string]
              }
            }
            subscription: number
          }
        }

        const subId = subMessage.params.subscription

        const matchingSubMeta = this._wsSubsMeta.get(subId)

        if (matchingSubMeta !== undefined) {
          const accountData = Buffer.from(subMessage.params.result.value.data[0], 'base64')
          const slot = message.params.result.context.slot

          this._update(matchingSubMeta, accountData, slot)
        } else {
          throw new Error(`Unknown notification message (no matching sub id)`)
        }

        return
      }

      throw new Error(`Unknown message ` + message.method)
    }

    ws.onerror = (event) => {
      logger.log('info', `Received RPC WebSocket error, error message: ${event.message}`, {
        market: this._options.marketName
      })
    }

    ws.onclose = (event) => {
      logger.log('info', `Received RPC WebSocket close, reason: ${event.reason}, code: ${event.code}`, {
        market: this._options.marketName
      })
      this._restartConnection(ws)
    }
  }

  private _restartConnection(ws: WebSocket) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.terminate()
    }

    logger.log('info', 'Restarting RPC WebSocket connection...', { market: this._options.marketName })

    this._wsSubsMeta.clear()
    this._clearTimers()
    this._resetAccountData()

    this.onAccountsChange({ reset: true })

    this._connectAndStreamData()
  }

  private _clearTimers() {
    if (this._publishTID !== undefined) {
      clearTimeout(this._publishTID)
    }
    if (this._pingTID !== undefined) {
      clearInterval(this._pingTID)
    }
  }

  private _resetAccountData() {
    this._accountsData = {
      bids: undefined,
      asks: undefined,
      eventQueue: undefined
    }
    this._slotStartTimestamp = undefined
    this._currentSlot = undefined
    this._state = 'PRISTINE'
  }

  private _subscribeToAccountsNotifications(ws: WebSocket) {
    for (const meta of this._accountsMeta) {
      if (ws.readyState !== WebSocket.OPEN) {
        return
      }

      this._sendMessage(ws, {
        jsonrpc: '2.0',
        id: meta.reqId,
        method: 'accountSubscribe',
        params: [
          meta.address,
          {
            encoding: 'base64',
            commitment: this._options.commitment
          }
        ]
      })
    }
  }

  private _sendPeriodicPings(ws: WebSocket) {
    if (this._pingTID) {
      clearInterval(this._pingTID)
    }

    this._pingTID = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        return
      }

      this._sendMessage(ws, { jsonrpc: '2.0', method: 'ping', params: null })
    }, 5 * 1000)
  }

  private _sendMessage(ws: WebSocket, message: any) {
    if (ws.readyState !== WebSocket.OPEN) {
      return
    }

    ws.send(JSON.stringify(message))
  }

  private _publish = () => {
    const now = new Date().valueOf()
    const slotTimespan = now - this._slotStartTimestamp!

    if (slotTimespan > 400) {
      logger.log('debug', `Slow accounts notification, slot ${this._currentSlot}, ${slotTimespan}ms`, {
        market: this._options.marketName
      })
    }

    this.onAccountsChange({
      accountsData: this._accountsData,
      slot: this._currentSlot!.toString(),
      reset: false
    })

    this._resetAccountData()

    if (this._publishTID !== undefined) {
      clearTimeout(this._publishTID)
      this._publishTID = undefined
    }

    this._state = 'PUBLISHED'
  }

  private _restartPublishTimer() {
    // wait up to 6s for remaining accounts notifications
    // this handles scenario when there was for example only 'asks' account notification
    // for a given slot so we still wait for remaining accounts notifications and there is no changes
    // for next slots for tracked accounts
    // we assume that if up to 6 seconds there's no further notifications
    // it's safe to assume that there won't be more for given slot

    if (this._publishTID !== undefined) {
      clearTimeout(this._publishTID)
    }

    this._publishTID = setTimeout(() => {
      this._publish()
    }, 6000)
  }

  private _receivedDataForAllAccounts() {
    return (
      this._accountsData.bids !== undefined &&
      this._accountsData.asks !== undefined &&
      this._accountsData.eventQueue !== undefined
    )
  }

  private _resetPendingNotificationState() {
    // we had out of order notification, let's clear pending accounts data state
    this._resetAccountData()
    if (this._publishTID !== undefined) {
      clearTimeout(this._publishTID)
    }
    // and notify about reset
    this.onAccountsChange({ reset: true })
  }

  private _update(accountName: 'bids' | 'asks' | 'eventQueue', accountData: Buffer, slot: number) {
    if (logger.level === 'debug') {
      logger.log('debug', `Received ${accountName} account update, current state ${this._state}`, {
        market: this._options.marketName,
        slot
      })
    }

    if (this._state === 'PUBLISHED') {
      // if after we published accounts notification
      // and for some reason next received notification is for already published slot or older
      // restart sub as it's this is situation that should never happen
      if (slot <= this._currentSlot!) {
        logger.log(
          'warn',
          `Out of order notification for PUBLISHED event: current slot ${this._currentSlot}, update slot: ${slot}, resetting...`,
          { market: this._options.marketName }
        )
        this._resetPendingNotificationState()
      } else {
        // otherwise move to pristine state
        this._state = 'PRISTINE'
      }
    }

    if (this._state === 'PRISTINE') {
      this._currentSlot = slot
      this._state = 'PENDING'
    }

    if (this._state === 'PENDING') {
      this._restartPublishTimer()
      // event for the same slot, just update the data for account
      if (slot === this._currentSlot) {
        if (this._slotStartTimestamp === undefined) {
          this._slotStartTimestamp = new Date().valueOf()
        }

        if (this._accountsData[accountName] !== undefined) {
          throw new Error(
            `Received second update for ${accountName} account for slot ${slot}, market ${this._options.marketName}`
          )
        }
        this._accountsData[accountName] = accountData

        // it's pending but since we have data for all accounts for current slot we can publish immediately
        if (this._receivedDataForAllAccounts()) {
          this._publish()
        }
      } else if (slot > this._currentSlot!) {
        // we received data for next slot, let's publish data for current slot
        this._publish()
        // and run the update again
        this._update(accountName, accountData, slot)
      } else {
        logger.log(
          'warn',
          `Out of order notification for PENDING event: current slot ${this._currentSlot}, update slot: ${slot}, resetting...`,
          { market: this._options.marketName }
        )
        this._resetPendingNotificationState()
      }
    }
  }
}

export type AccountsNotification =
  | {
      readonly reset: true
    }
  | {
      readonly accountsData: AccountsData
      readonly slot: string
      readonly reset: false
    }

export type AccountName = 'bids' | 'asks' | 'eventQueue'
export type AccountsData = {
  [key in AccountName]?: Buffer
}