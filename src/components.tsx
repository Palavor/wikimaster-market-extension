import {useEffect, useState} from 'react'
import {ArrowUpRight, Gavel, PackageOpen, TrendingDown, TrendingUp} from 'lucide-react'
import type {ScannerCard} from './types'

function readCachedPrice(cardId?: string) {
    if (!cardId) return undefined
    try {
        const cache = JSON.parse(localStorage.getItem('wikimasters-card-prices-v2') || '{}') as Record<string, number | {
            price: number
        }[]>
        const value = cache[cardId]
        return Array.isArray(value) ? value.at(-1)?.price : value
    } catch {
        return undefined
    }
}

export function ScoreBadge({score}: { score: number }) {
    return <span
        className={`score-badge ${score >= 85 ? 'score-hot' : score >= 75 ? 'score-warm' : 'score-calm'}`}>{score}/100</span>
}

export function RarityBadge({rarity}: { rarity: string }) {
    const code = rarity.trim().toUpperCase()
    const supportedCode = ['L', 'UR', 'SR', 'R', 'PC', 'C'].includes(code) ? code : 'OTHER'
    return <span
        className={`rarity-badge rarity-${supportedCode.toLowerCase()}`}>{code === 'OTHER' ? rarity : code}</span>
}

export function CardRow({card, onSelect}: { card: ScannerCard; onSelect: (card: ScannerCard) => void }) {
    const TrendIcon = card.trend >= 0 ? TrendingUp : TrendingDown
    return (
        <button className="card-row" onClick={() => {
            const cachedPrice = readCachedPrice(card.cardId);
            onSelect({...card, marketPrice: cachedPrice ?? card.marketPrice, priceLoading: true})
        }} type="button">
            <div className="card-thumb">{card.imageUrl ? <img src={card.imageUrl} alt=""/> :
                <PackageOpen size={18}/>}</div>
            <div className="card-copy">
                
                <div className="card-title-line"><RarityBadge
                    rarity={card.rarity}/><strong>{card.name}</strong><ScoreBadge score={card.score}/></div>
                <span>{card.set}</span>
                <div className="card-meta"><span>{card.quantity} exemplaire{card.quantity > 1 ? 's' : ''}</span>{card.purchasePrice !== undefined && <span>Achetée {card.purchasePrice.toFixed(0)} Wikibidous</span>}<span
                    className={`trend ${card.trend < 0 ? 'trend-down' : ''}`}><TrendIcon
                    size={12}/> {card.trend > 0 ? '+' : ''}{card.trend}%</span></div>
            </div>
            <div className="card-value">{card.priceLoading ? <>
                <strong><span className="loader" aria-hidden="true" /></strong><span>Recherche du prix</span></> : card.marketPrice > 0 ? <>
                <strong>{card.marketPrice.toFixed(2).replace('.', ',')} Wikibidous</strong><span>× {card.quantity} = {(card.marketPrice * card.quantity).toFixed(2).replace('.', ',')} Wikibidous</span></> : <>
                <strong>—</strong><span>Estimation indisponible</span></>}</div>
            <ArrowUpRight className="row-arrow" size={17}/>
        </button>
    )
}

function formatRemainingTime(auctionEndsIn?: string) {
    if (!auctionEndsIn) return undefined
    const endTime = new Date(auctionEndsIn).getTime()
    if (Number.isNaN(endTime)) return undefined

    const remainingSeconds = Math.max(0, Math.floor((endTime - Date.now()) / 1000))
    const hours = Math.floor(remainingSeconds / 3600)
    const minutes = Math.floor((remainingSeconds % 3600) / 60)
    const seconds = remainingSeconds % 60

    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
}

export function AuctionCard({card, onSelect}: { card: ScannerCard; onSelect?: (card: ScannerCard) => void }) {
    const [remainingTime, setRemainingTime] = useState(() => formatRemainingTime(card.auctionEndsIn))
    const endDate = card.auctionEndsIn ? new Date(card.auctionEndsIn).toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    }) : '—'

    useEffect(() => {
        const updateRemainingTime = () => setRemainingTime(formatRemainingTime(card.auctionEndsIn))
        updateRemainingTime()
        const timer = window.setInterval(updateRemainingTime, 1000)
        return () => window.clearInterval(timer)
    }, [card.auctionEndsIn])

    return (
        <button className={`auction-card ${card.outbid ? 'auction-card-outbid' : ''}`} onClick={() => onSelect?.(card)} type="button">
            <div className="auction-card-top">
                <div className="live-dot"><span/> {card.bidding ? 'ACHAT EN COURS' : card.auctionCount > 0 ? 'VENTE EN COURS' : 'AUCUN ACHETEUR'}</div>
                <span className="auction-time">{remainingTime ?? endDate ?? '—'}</span></div>
            {card.outbid && <div className="outbid-notice">Vous avez été surenchéri</div>}
            <div className="auction-main">
                <div className="auction-thumb">{card.imageUrl ? <img src={card.imageUrl} alt=""/> :
                    <Gavel size={20}/>}</div>
                <div className="card-title-line"> 
                  <RarityBadge rarity={card.rarity}/>
                  <strong>{card.name}</strong>
                </div>
                <div>
                  <span>Prix initial : {(card.initialPrice ?? card.startingPrice ?? 0).toFixed(0)} Wikibidous</span>
                  <br/>
                  <span>{card.auctionCount} enchère{card.auctionCount > 1 ? 's' : ''}</span>
                </div>
            </div>
            <div className="auction-footer">
                <div>
                    <small>Dernière mise</small>
                    <strong>{(card.currentBid ?? card.highestBid ?? card.initialPrice ?? 0).toFixed(0)} Wikibidous</strong>
                    {/* <small>Prix initial : {(card.initialPrice ?? card.startingPrice ?? 0).toFixed(0)} · Fin : {endDate}</small> */}
                </div>
                {/*<button type="button" aria-label={`Voir l'enchère de ${card.name}`}><ArrowUpRight size={16}/></button>*/}
            </div>
        </button>
    )
}

export function BidDialog({card, onCancel, onSubmit}: { card: ScannerCard; onCancel: () => void; onSubmit: (amount: number) => Promise<void> }) {
    const [amount, setAmount] = useState(String(Math.round((card.currentBid ?? card.highestBid ?? 0) * 1.1 + 1)))
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState('')

    const submit = async () => {
        const parsedAmount = Number(amount)
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            setError('Indiquez un montant valide.')
            return
        }
        setSubmitting(true)
        setError('')
        try {
            await onSubmit(parsedAmount)
        } catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : 'Enchère impossible.')
        } finally {
            setSubmitting(false)
        }
    }

    return <div className="bid-dialog-overlay" role="presentation" onClick={onCancel}>
        <div className="bid-dialog" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="bid-dialog-title">
            <h2 id="bid-dialog-title">Enchérir sur {card.name}</h2>
            <p>Enchère actuelle : <strong>{(card.currentBid ?? card.highestBid ?? 0).toFixed(0)} Wikibidous</strong></p>
            <label>Votre montant<input type="number" min="1" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus /></label>
            {error && <p className="auction-form-error">{error}</p>}
            <div className="bid-dialog-actions"><button type="button" onClick={onCancel}>Annuler</button><button className="detail-cta" type="button" disabled={submitting} onClick={submit}>{submitting && <span className="inline-loader" aria-hidden="true"/>}{submitting ? 'Envoi…' : 'Enchérir'}<Gavel size={16}/></button></div>
        </div>
    </div>
}

export function AuctionForm({onSubmit, activeCount, initialBaseAmount}: {
    onSubmit: (baseAmount: number, durationMinutes: number) => Promise<void>;
    activeCount: number;
    initialBaseAmount: number
}) {
    const [baseAmount, setBaseAmount] = useState(String(initialBaseAmount))
    const [durationMinutes, setDurationMinutes] = useState('10')
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState('')
    const durations = [['10 min', '10'], ['30 min', '30'], ['1 h', '60'], ['3 h', '180'], ['6 h', '360'], ['12 h', '720'], ['24 h', '1440']]

    const submit = async () => {
        const amount = Number(baseAmount)
        if (activeCount >= 5) {
            setError('Limite de 5 enchères actives atteinte.');
            return
        }
        if (!Number.isFinite(amount) || amount <= 0) {
            setError('Indiquez un montant de départ valide.');
            return
        }
        setError('')
        setSubmitting(true)
        try {
            await onSubmit(amount, Number(durationMinutes))
        } catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : 'Création impossible.')
        } finally {
            setSubmitting(false)
        }
    }

    return <div className="auction-form">
        <div className="auction-form-heading"><strong>Ajouter aux enchères</strong><span>{activeCount}/5 actives</span>
        </div>
        <label>Montant de départ<input type="number" min="1" step="1" value={baseAmount}
                                       onChange={(event) => setBaseAmount(event.target.value)}/></label><label>Durée<select
        value={durationMinutes}
        onChange={(event) => setDurationMinutes(event.target.value)}>{durations.map(([label, value]) => <option
        value={value} key={value}>{label}</option>)}</select></label>{error &&
        <p className="auction-form-error">{error}</p>}
        <button className="detail-cta" type="button" disabled={submitting || activeCount >= 5}
            onClick={submit}>{submitting && <span className="inline-loader" aria-hidden="true"/>}{submitting ? 'Publication…' : activeCount >= 5 ? 'Limite atteinte' : 'Publier l’enchère'}<Gavel
            size={16}/></button>
    </div>
}
