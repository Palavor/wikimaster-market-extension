export type Recommendation = 'SELL' | 'WATCH' | 'KEEP' | 'UNKNOWN'
export type Liquidity = 'high' | 'medium' | 'low' | 'unknown'

export interface AuctionDurationOption {
  label: string
  minutes: number
}

export interface ScannerCard {
  id: string
  cardId?: string
  owned?: boolean
  bidding?: boolean
  outbid?: boolean
  marketOpportunity?: boolean
  name: string
  set: string
  number: string
  rarity: string
  quantity: number
  marketPrice: number
  estimatedPrice?: number
  qScore?: number
  priceLoading?: boolean
  purchasePrice?: number
  gain: number
  score: number
  liquidity: Liquidity
  recommendation: Recommendation
  trend: number
  lastUpdated: string
  auctionCount: number
  bidAmounts?: number[]
  highestBid?: number
  currentBid?: number
  currentBidderId?: string
  initialPrice?: number
  auctionEndsIn?: string
  imageUrl?: string
  sellerId?: string
  startingPrice?: number
  status?: string
  url?: string
  listing?: boolean
}
