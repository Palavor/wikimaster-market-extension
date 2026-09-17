import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  CircleDollarSign,
  Clock3,
  Gavel,
  PackageOpen,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  TrendingUp,
  X,
} from "lucide-react";
import { AuctionCard, AuctionForm, BidDialog, CardRow } from "./components";
import type { ScannerCard } from "./types";
import "./App.css";

const priceCacheKey = "wikimasters-card-prices-v2";
const collectionCacheKey = "wikimasters-collection-cache-v3";
const marketplaceCacheKey = "wikimasters-marketplace-snapshot-v1";
const marketplaceRefreshSeconds = 15;
type PricePoint = { price: number; at: string };

function readMarketplaceCache() {
  try {
    return JSON.parse(localStorage.getItem(marketplaceCacheKey) || "null") as {
      snapshot?: {
        auctions?: Partial<ScannerCard>[];
        bidding?: Partial<ScannerCard>[];
        won?: Partial<ScannerCard>[];
        marketplaceOpportunities?: Partial<ScannerCard>[];
      };
      fetchedAt?: string;
    } | null;
  } catch {
    return null;
  }
}

function writeMarketplaceCache(snapshot: {
  auctions?: Partial<ScannerCard>[];
  bidding?: Partial<ScannerCard>[];
  won?: Partial<ScannerCard>[];
  marketplaceOpportunities?: Partial<ScannerCard>[];
}) {
  try {
    localStorage.setItem(
      marketplaceCacheKey,
      JSON.stringify({ snapshot, fetchedAt: new Date().toISOString() }),
    );
  } catch {
    // Keep the live polling usable when local storage is unavailable.
  }
}

function readExtensionCollectionCache(): Promise<{
  fetchedAt?: number;
  items?: unknown[];
  cards?: Partial<ScannerCard>[];
} | null> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([collectionCacheKey], (values) => {
        const cached = values?.[collectionCacheKey] as
          | { fetchedAt?: number; items?: unknown[]; cards?: Partial<ScannerCard>[] }
          | undefined;
        resolve(cached && Array.isArray(cached.items) ? cached : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function normalizeCachedCollectionItems(items: unknown[]): Partial<ScannerCard>[] {
  return items.map((item, index) => {
    const value = item as Record<string, unknown>;
    const cardId = value.card_id ?? value.cardId ?? value.id;
    return {
      id: cardId ? String(cardId) : `cached-${index}`,
      cardId: cardId ? String(cardId) : undefined,
      name: String(value.name ?? value.title ?? value.cardName ?? "Carte WikiMasters"),
      set: String(value.set ?? value.setName ?? value.extension ?? "Set inconnu"),
      number: String(value.number ?? value.cardNumber ?? value.card_number ?? "—"),
      rarity: String(value.rarity ?? value.rarityName ?? "Inconnue"),
      quantity: Number(value.quantity ?? value.count ?? 1),
      imageUrl: typeof value.imageUrl === "string" ? value.imageUrl : undefined,
      qScore: typeof value.qScore === "number" ? value.qScore : undefined,
    };
  });
}

function mapCollectionCards(cards: Partial<ScannerCard>[]): ScannerCard[] {
  return cards.map((card, index) => ({
    id: card.id || `cached-${index}`,
    name: card.name || "Carte WikiMasters",
    set: card.set || "Set inconnu",
    number: card.number || "—",
    rarity: card.rarity || "Inconnue",
    quantity: card.quantity || 1,
    marketPrice: card.cardId
      ? (readCachedPrice(card.cardId) ?? card.marketPrice ?? 0)
      : card.marketPrice || 0,
    estimatedPrice: card.cardId
      ? readCachedPrice(card.cardId)
      : card.marketPrice,
    priceLoading: false,
    gain: 0,
    score: card.qScore || 0,
    qScore: card.qScore,
    liquidity: "unknown",
    recommendation: "UNKNOWN",
    trend: card.cardId ? readCachedTrend(card.cardId) : 0,
    lastUpdated: "cache WikiMasters",
    auctionCount: 0,
    imageUrl: card.imageUrl,
    cardId: card.cardId,
    owned: true,
  }));
}

function readPriceHistory(cardId: string): PricePoint[] {
  try {
    const cache = JSON.parse(
      localStorage.getItem(priceCacheKey) || "{}",
    ) as Record<string, number | PricePoint[]>;
    const value = cache[cardId];
    if (Array.isArray(value))
      return value.filter((point) => Number.isFinite(point.price));
    return typeof value === "number" ? [{ price: value, at: "" }] : [];
  } catch {
    return [];
  }
}

function readCachedPrice(cardId: string) {
  return readPriceHistory(cardId).at(-1)?.price;
}

function readCachedTrend(cardId: string) {
  const history = readPriceHistory(cardId);
  const current = history.at(-1)?.price;
  const previous = history.at(-2)?.price;
  return current !== undefined && previous && previous > 0
    ? ((current - previous) / previous) * 100
    : 0;
}

function formatPricePointDate(value: string) {
  if (!value) return "Date inconnue";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date inconnue"
    : date.toLocaleDateString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
}

function writeCachedPrice(cardId: string, marketPrice: number) {
  try {
    const cache = JSON.parse(
      localStorage.getItem(priceCacheKey) || "{}",
    ) as Record<string, number | PricePoint[]>;
    const history = readPriceHistory(cardId);
    const last = history.at(-1);
    if (!last || last.price !== marketPrice) {
      history.push({ price: marketPrice, at: new Date().toISOString() });
    } else {
      history[history.length - 1] = {
        ...last,
        at: new Date().toISOString(),
      };
    }
    localStorage.setItem(
      priceCacheKey,
      JSON.stringify({ ...cache, [cardId]: history.slice(-30) }),
    );
  } catch {
    // localStorage can be unavailable in a restricted extension context.
  }
}

function App() {
  const [logsVisible, setLogsVisible] = useState(false);
  const [logs, setLogs] = useState<string[]>(() => {
    const timestamp = new Date().toLocaleTimeString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return [`[${timestamp}] Démarrage de la synchronisation`];
  });
  const [cards, setCards] = useState<ScannerCard[]>([]);
  const [dataSource, setDataSource] = useState<
    "loading" | "local-cache" | "wikimasters-api"
  >("loading");
  const [summaryValue, setSummaryValue] = useState<number | null>(null);
  const [summaryGain, setSummaryGain] = useState<number | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedCard, setSelectedCard] = useState<ScannerCard | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [recommendation, setRecommendation] = useState<
    "ALL" | "SELL" | "WATCH"
  >("ALL");
  const [sort, setSort] = useState<"score" | "marketPrice" | "gain">("score");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [refreshToken, setRefreshToken] = useState(0);
  const [activeTab, setActiveTab] = useState<
    "opportunities" | "collection" | "selling"
  >("collection");
  const [auctionCard, setAuctionCard] = useState<ScannerCard | null>(null);
  const [bidCard, setBidCard] = useState<ScannerCard | null>(null);
  const priceRequests = useRef(new Set<string>());
  const lastAuthState = useRef<boolean | undefined>(undefined);
  const salesRefreshCountdownRef = useRef(marketplaceRefreshSeconds);
  const salesRefreshInFlight = useRef(false);
  const [isRefreshingSales, setIsRefreshingSales] = useState(false);
  const [isLoadingCollection, setIsLoadingCollection] = useState(false);
  const [isLoadingMarketplace, setIsLoadingMarketplace] = useState(false);
  const [salesRefreshCountdown, setSalesRefreshCountdown] = useState(
    marketplaceRefreshSeconds,
  );

  const createAuction = async (
    card: ScannerCard,
    baseAmount: number,
    durationMinutes: number,
  ) => {
    const response = await chrome.runtime.sendMessage({
      type: "CREATE_AUCTION",
      payload: { cardId: card.cardId, baseAmount, durationMinutes },
    });
    if (!response?.ok)
      throw new Error(response?.error || "Impossible de créer l’enchère.");
    addLog(`Enchère créée pour ${card.name}`);
    setSelectedCard(null);
    setRefreshToken((token) => token + 1);
  };

  const placeBid = async (card: ScannerCard, amount: number) => {
    const response = await chrome.runtime.sendMessage({
      type: "PLACE_BID",
      payload: { auctionId: card.id, amount },
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Enchère impossible.");
    }
    setBidCard(null);
    addLog(`Enchère de ${amount} Wikibidous envoyée pour ${card.name}`);
    refreshSales();
  };

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setLogs((currentLogs) => [
      ...currentLogs.slice(-39),
      `[${timestamp}] ${message}`,
    ]);
  };

  const openLogin = () => {
    addLog("Ouverture de la page de connexion WikiMasters");
    chrome.runtime
      .sendMessage({ type: "OPEN_WIKIMASTERS_LOGIN" })
      .then((response) => {
        addLog(
          response?.ok
            ? "Page de connexion ouverte"
            : `Impossible d’ouvrir la connexion : ${response?.error || "erreur inconnue"}`,
        );
        if (response?.authenticated) {
          setSyncError(null);
          setDataSource("loading");
          setRefreshToken((token) => token + 1);
        }
      })
      .catch((error: Error) =>
        addLog(`Erreur ouverture connexion : ${error.message}`),
      );
  };

  useEffect(() => {
    const handleAuthStatus = (message: {
      type?: string;
      payload?: { requiresLogin?: boolean };
    }) => {
      if (
        message.type !== "WIKIMASTERS_AUTH_STATUS" ||
        message.payload?.requiresLogin === undefined
      )
        return;
      if (message.payload.requiresLogin) {
        lastAuthState.current = true;
        return;
      }
      if (lastAuthState.current === false) return;
      lastAuthState.current = false;
      addLog("Session WikiMasters détectée, actualisation des données");
      setSyncError(null);
      setDataSource("loading");
      setRefreshToken((token) => token + 1);
    };
    chrome.runtime.onMessage.addListener(handleAuthStatus);
    return () => chrome.runtime.onMessage.removeListener(handleAuthStatus);
  }, []);

  const applyMarketplaceSnapshot = (
    snapshot: {
    auctions?: Partial<ScannerCard>[];
    bidding?: Partial<ScannerCard>[];
    won?: Partial<ScannerCard>[];
    marketplaceOpportunities?: Partial<ScannerCard>[];
    },
    persist = true,
  ) => {
    if (persist) writeMarketplaceCache(snapshot);
    const sales = (snapshot.auctions || []).map(
      (auction, index): ScannerCard => ({
        id: auction.id || `auction-${index}`,
        cardId: auction.cardId,
        name: auction.name || "Carte en vente",
        set: "Marketplace WikiMasters",
        number: auction.number || "—",
        rarity: auction.rarity || "—",
        quantity: 1,
        marketPrice: auction.highestBid || auction.startingPrice || 0,
        currentBid: auction.currentBid,
        initialPrice: auction.initialPrice,
        gain: 0,
        score: auction.qScore || 0,
        qScore: auction.qScore,
        liquidity: "unknown",
        recommendation: "UNKNOWN",
        trend: auction.cardId ? readCachedTrend(auction.cardId) : 0,
        lastUpdated: "vente WikiMasters",
        auctionCount: auction.auctionCount || 0,
        bidAmounts: auction.bidAmounts,
        highestBid: auction.highestBid,
        startingPrice: auction.startingPrice,
        sellerId: auction.sellerId,
        status: auction.status,
        url: auction.url,
        auctionEndsIn: auction.auctionEndsIn,
        imageUrl: auction.imageUrl,
        listing: auction.listing,
        owned: false,
      }),
    );
    const wonCards = (snapshot.won || []).map(
      (auction, index): ScannerCard => ({
        id: auction.id || `won-${index}`,
        cardId: auction.cardId,
        name: auction.name || "Carte achetée",
        set: "Marketplace WikiMasters",
        number: auction.number || "—",
        rarity: auction.rarity || "—",
        quantity: 1,
        marketPrice: auction.marketPrice || auction.currentBid || auction.purchasePrice || 0,
        purchasePrice: auction.purchasePrice || auction.currentBid || auction.highestBid || 0,
        currentBid: auction.currentBid,
        initialPrice: auction.initialPrice,
        gain: 0,
        score: auction.qScore || 0,
        qScore: auction.qScore,
        liquidity: "unknown",
        recommendation: "UNKNOWN",
        trend: auction.cardId ? readCachedTrend(auction.cardId) : 0,
        lastUpdated: "achat WikiMasters",
        auctionCount: auction.auctionCount || 0,
        bidAmounts: auction.bidAmounts,
        highestBid: auction.highestBid,
        startingPrice: auction.startingPrice,
        status: "won",
        url: auction.url,
        auctionEndsIn: auction.auctionEndsIn,
        imageUrl: auction.imageUrl,
        owned: true,
        listing: false,
      }),
    );
    const biddingCards = (snapshot.bidding || []).map(
      (auction, index): ScannerCard => ({
        id: auction.id || `bidding-${index}`,
        cardId: auction.cardId,
        name: auction.name || "Carte surveillée",
        set: "Marketplace WikiMasters",
        number: auction.number || "—",
        rarity: auction.rarity || "—",
        quantity: 1,
        marketPrice: auction.marketPrice || auction.currentBid || auction.highestBid || 0,
        currentBid: auction.currentBid,
        initialPrice: auction.initialPrice,
        gain: 0,
        score: auction.qScore || 0,
        qScore: auction.qScore,
        liquidity: "unknown",
        recommendation: "UNKNOWN",
        trend: auction.cardId ? readCachedTrend(auction.cardId) : 0,
        lastUpdated: "achat WikiMasters",
        auctionCount: auction.auctionCount || 0,
        bidAmounts: auction.bidAmounts,
        highestBid: auction.highestBid,
        startingPrice: auction.startingPrice,
        currentBidderId: auction.currentBidderId,
        status: "bidding",
        url: auction.url,
        auctionEndsIn: auction.auctionEndsIn,
        imageUrl: auction.imageUrl,
        owned: false,
        bidding: true,
        outbid: auction.outbid,
      }),
    );
    const opportunities = (snapshot.marketplaceOpportunities || []).map(
      (auction, index): ScannerCard => ({
        id: auction.id || `market-${index}`,
        cardId: auction.cardId,
        name: auction.name || "Carte du marché",
        set: "Marketplace WikiMasters",
        number: auction.number || "—",
        rarity: auction.rarity || "—",
        quantity: 1,
        marketPrice: auction.highestBid || auction.startingPrice || 0,
        currentBid: auction.currentBid,
        initialPrice: auction.initialPrice,
        gain: 0,
        score: auction.qScore || 0,
        qScore: auction.qScore,
        liquidity: "unknown",
        recommendation: "UNKNOWN",
        trend: auction.cardId ? readCachedTrend(auction.cardId) : 0,
        lastUpdated: "marketplace WikiMasters",
        auctionCount: auction.auctionCount || 0,
        highestBid: auction.highestBid,
        startingPrice: auction.startingPrice,
        auctionEndsIn: auction.auctionEndsIn,
        imageUrl: auction.imageUrl,
        marketOpportunity: true,
        owned: false,
      }),
    );
    setCards((currentCards) => {
      const collection = currentCards.filter((card) => card.owned === true);
      const currentOpportunities = currentCards.filter(
        (card) => card.marketOpportunity,
      );
      const mergedCards = [
        ...collection,
        ...sales,
        ...biddingCards,
        ...(snapshot.marketplaceOpportunities
          ? opportunities
          : currentOpportunities),
      ];
      return mergedCards.filter(
        (card, index, allCards) =>
          allCards.findIndex((candidate) => candidate.id === card.id) === index,
      );
    });
    chrome.runtime.sendMessage({
      type: "CHECK_BIDDING_NOTIFICATIONS",
      payload: { auctions: biddingCards },
    }).catch(() => undefined);
    addLog(
      `${sales.length} ventes, ${wonCards.length} achats et ${opportunities.length} opportunités chargés`,
    );
  };

  const refreshSales = () => {
    if (salesRefreshInFlight.current) return;
    salesRefreshInFlight.current = true;
    setIsRefreshingSales(true);
    addLog("Actualisation des ventes (page 1)");
    chrome.runtime
      .sendMessage({ type: "ANALYZE_SALES_API" })
      .then((response) => {
        if (response?.ok) applyMarketplaceSnapshot(response.snapshot);
        else
          addLog(
            `Ventes indisponibles : ${response?.error || "réponse invalide"}`,
          );
      })
      .catch((error: Error) =>
        addLog(`Erreur d’actualisation des ventes : ${error.message}`),
      )
      .finally(() => {
        salesRefreshInFlight.current = false;
        setIsRefreshingSales(false);
        salesRefreshCountdownRef.current = marketplaceRefreshSeconds;
        setSalesRefreshCountdown(marketplaceRefreshSeconds);
      });
  };

  const loadMarketplace = () => {
    setIsLoadingMarketplace(true);
    chrome.runtime
      .sendMessage({ type: "ANALYZE_MARKETPLACE_API" })
      .then((response) => {
        if (response?.ok) applyMarketplaceSnapshot(response.snapshot);
        else
          addLog(
            `Marketplace indisponible : ${response?.error || "réponse invalide"}`,
          );
      })
      .catch((error: Error) => addLog(`Erreur marketplace : ${error.message}`))
      .finally(() => setIsLoadingMarketplace(false));
  };

  const refreshCollection = () => {
    setSyncError(null);
    setDataSource("loading");
    setRefreshToken((token) => token + 1);
  };

  useEffect(() => {
    setIsLoadingCollection(true);
    addLog("Recherche du cache de la collection dans l’extension");
    readExtensionCollectionCache().then((cachedCollection) => {
      if (!cachedCollection) {
        addLog("Aucun cache de collection disponible dans l’extension");
        return;
      }
      const cachedItems = cachedCollection.cards || normalizeCachedCollectionItems(cachedCollection.items || []);
      const cachedCards = mapCollectionCards(cachedItems);
      if (!cachedCards.length) {
        addLog("Cache de collection vide dans l’extension");
        return;
      }
      setCards((currentCards) => [
        ...cachedCards,
        ...currentCards.filter((card) => card.owned !== true),
      ]);
      setDataSource("local-cache");
      addLog(`${cachedCards.length} cartes chargées depuis le cache de l’extension`);
    });
    addLog("Recherche du cache des ventes et achats");
    const cachedMarketplace = readMarketplaceCache();
    if (cachedMarketplace?.snapshot) {
      applyMarketplaceSnapshot(cachedMarketplace.snapshot, false);
      addLog(
        `Cache ventes/achats chargé${cachedMarketplace.fetchedAt ? ` (${new Date(cachedMarketplace.fetchedAt).toLocaleTimeString("fr-FR")})` : ""}`,
      );
    } else {
      addLog("Aucun cache ventes/achats disponible");
    }
    refreshSales();

    chrome.runtime
      .sendMessage({
        type: "ANALYZE_WIKIMASTERS_API",
        payload: { forceRefresh: refreshToken > 0 },
      })
      .then((response) => {
        addLog(
          response?.ok
            ? "Réponse reçue du service worker"
            : `Échec service worker : ${response?.error || "réponse invalide"}`,
        );
        response?.diagnostics?.forEach((diagnostic: string) =>
          addLog(diagnostic),
        );
        response?.snapshot?.diagnostics?.forEach((diagnostic: string) =>
          addLog(diagnostic),
        );
        if (!response?.ok || !response.snapshot?.cards?.length) {
          addLog(
            `Aucune carte exploitable (${response?.snapshot?.cards?.length || 0} reçue)`,
          );
          setSyncError(
            response?.error || "Aucune carte reçue depuis WikiMasters",
          );
          return;
        }
        addLog(`${response.snapshot.cards.length} cartes reçues depuis l’API`);
        addLog(
          `${response.snapshot.auctions?.length || 0} ventes reçues depuis l’API`,
        );
        const apiCards = mapCollectionCards(response.snapshot.cards);
        const auctionCards: ScannerCard[] = (
          response.snapshot.auctions || []
        ).map((auction: Partial<ScannerCard>, index: number) => ({
          id: auction.id || `auction-${index}`,
          cardId: auction.cardId,
          name: auction.name || "Carte en vente",
          set: "Marketplace WikiMasters",
          number: auction.number || "—",
          rarity: auction.rarity || "—",
          quantity: 1,
          marketPrice: auction.highestBid || 0,
          currentBid: auction.currentBid,
          initialPrice: auction.initialPrice,
          gain: 0,
          score: auction.qScore || 0,
          liquidity: "unknown",
          recommendation: "UNKNOWN",
          trend: auction.cardId ? readCachedTrend(auction.cardId) : 0,
          lastUpdated: "vente WikiMasters",
          auctionCount: auction.auctionCount || 0,
          bidAmounts: auction.bidAmounts,
          highestBid: auction.highestBid,
          startingPrice: auction.startingPrice,
          sellerId: auction.sellerId,
          status: auction.status,
          url: auction.url,
          auctionEndsIn: auction.auctionEndsIn,
          imageUrl: auction.imageUrl,
          qScore: auction.qScore,
          listing: auction.listing,
          owned: false,
        }));
        const marketplaceOpportunityCards: ScannerCard[] = (
          response.snapshot.marketplaceOpportunities || []
        ).map((auction: Partial<ScannerCard>, index: number) => ({
          id: auction.id || `market-${index}`,
          cardId: auction.cardId,
          name: auction.name || "Carte du marché",
          set: "Marketplace WikiMasters",
          number: auction.number || "—",
          rarity: auction.rarity || "—",
          quantity: 1,
          marketPrice: auction.highestBid || auction.startingPrice || 0,
          currentBid: auction.currentBid,
          initialPrice: auction.initialPrice,
          gain: 0,
          score: auction.qScore || 0,
          qScore: auction.qScore,
          liquidity: "unknown",
          recommendation: "UNKNOWN",
          trend: auction.cardId ? readCachedTrend(auction.cardId) : 0,
          lastUpdated: "marketplace WikiMasters",
          auctionCount: auction.auctionCount || 0,
          highestBid: auction.highestBid,
          startingPrice: auction.startingPrice,
          auctionEndsIn: auction.auctionEndsIn,
          imageUrl: auction.imageUrl,
          marketOpportunity: true,
          owned: false,
        }));
        const mergedCards = apiCards.map((card) => {
          const auction = auctionCards.find(
            (candidate) =>
              (candidate.cardId &&
                card.cardId &&
                candidate.cardId === card.cardId) ||
              candidate.name.toLowerCase() === card.name.toLowerCase(),
          );
          return auction
            ? {
                ...card,
                marketPrice:
                  card.marketPrice ||
                  auction.highestBid ||
                  auction.startingPrice ||
                  0,
                auctionCount: auction.auctionCount,
                bidAmounts: auction.bidAmounts,
                highestBid: auction.highestBid,
                currentBid: auction.currentBid,
                initialPrice: auction.initialPrice,
                startingPrice: auction.startingPrice,
                auctionEndsIn: auction.auctionEndsIn,
                listing: auction.listing || card.listing,
                status: auction.status,
                url: auction.url,
              }
            : card;
        });
        const collectionNames = new Set(
          apiCards.map((card) => card.name.toLowerCase()),
        );
        setCards((currentCards) => {
          const mergedCardsWithMarketplace = [
            ...mergedCards,
            ...currentCards.filter((card) => card.owned !== true),
            ...auctionCards.filter(
              (auction) => !collectionNames.has(auction.name.toLowerCase()),
            ),
            ...marketplaceOpportunityCards,
          ];
          return mergedCardsWithMarketplace.filter(
            (card, index, allCards) =>
              allCards.findIndex((candidate) => candidate.id === card.id) === index,
          );
        });
        setSummaryValue(response.snapshot.summary?.estimatedValue ?? null);
        setSummaryGain(response.snapshot.summary?.potentialGain ?? null);
        setDataSource(
          response.snapshot.source === "local-cache"
            ? "local-cache"
            : "wikimasters-api",
        );
        setSyncError(null);
        addLog("Collection affichée ; chargement des prix en arrière-plan");
      })
      .catch((error: Error) => {
        addLog(`Erreur de synchronisation : ${error.message}`);
        setSyncError(
          error.message ||
            "Aucune donnée disponible : impossible de joindre l’API WikiMasters",
        );
        })
        .finally(() => setIsLoadingCollection(false));
  }, [refreshToken]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      salesRefreshCountdownRef.current -= 1;
      if (salesRefreshCountdownRef.current <= 0) {
        refreshSales();
      } else {
        setSalesRefreshCountdown(salesRefreshCountdownRef.current);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const pendingCards = cards.filter(
      (card) =>
        card.owned &&
        card.cardId &&
        readCachedPrice(card.cardId) === undefined &&
        !priceRequests.current.has(card.cardId),
    );
    pendingCards.forEach((card) => {
      if (!card.cardId) return;
      priceRequests.current.add(card.cardId);
      setCards((currentCards) =>
        currentCards.map((currentCard) =>
          currentCard.id === card.id
            ? { ...currentCard, priceLoading: true }
            : currentCard,
        ),
      );
      setTimeout(() => {
        chrome.runtime
          .sendMessage({
            type: "FETCH_CARD_PRICE",
            payload: { cardId: card.cardId, rarity: card.rarity },
          })
          .then((response) => {
            const marketPrice = Number(response?.marketPrice) || 0;
            writeCachedPrice(card.cardId as string, marketPrice);
            setCards((currentCards) =>
              currentCards.map((currentCard) =>
                currentCard.id === card.id
                  ? {
                      ...currentCard,
                      marketPrice,
                      estimatedPrice: marketPrice,
                      trend: readCachedTrend(card.cardId as string),
                      priceLoading: false,
                    }
                  : currentCard,
              ),
            );
            addLog(
              response?.ok
                ? `Prix chargé pour ${card.name}`
                : `Prix indisponible pour ${card.name}`,
            );
          })
          .catch(() =>
            setCards((currentCards) =>
              currentCards.map((currentCard) =>
                currentCard.id === card.id
                  ? { ...currentCard, priceLoading: false }
                  : currentCard,
              ),
            ),
          );
      }, 0);
    });
  }, [cards]);

  useEffect(() => {
    const card = selectedCard;
    if (!card?.cardId || !card.priceLoading) return;
    let active = true;
    chrome.runtime
      .sendMessage({
        type: "FETCH_CARD_PRICE",
        payload: { cardId: card.cardId, rarity: card.rarity },
      })
      .then((response) => {
        if (!active) return;
        const marketPrice = Number(response?.marketPrice) || 0;
        writeCachedPrice(card.cardId as string, marketPrice);
        const updatedCard = {
          ...card,
          marketPrice,
          trend: readCachedTrend(card.cardId as string),
          priceLoading: false,
        };
        setCards((currentCards) =>
          currentCards.map((currentCard) =>
            currentCard.id === card.id ? updatedCard : currentCard,
          ),
        );
        setSelectedCard(updatedCard);
        addLog(
          response?.ok
            ? `Prix chargé pour ${card.name}`
            : `Prix indisponible pour ${card.name}`,
        );
      })
      .catch((error: Error) => {
        if (!active) return;
        setSelectedCard({ ...card, priceLoading: false });
        addLog(`Erreur de chargement du prix : ${error.message}`);
      });
    return () => {
      active = false;
    };
  }, [selectedCard]);

  useEffect(() => {
    if (activeTab !== "opportunities") return;
    loadMarketplace();
  }, [activeTab]);

  const filteredCards = useMemo(() => {
    const direction = sortDirection === "asc" ? 1 : -1;
    return cards
      .filter(
        (card) =>
          card.name.toLowerCase().includes(query.toLowerCase()) ||
          card.set.toLowerCase().includes(query.toLowerCase()),
      )
      .filter(
        (card) =>
          recommendation === "ALL" || card.recommendation === recommendation,
      )
      .sort((a, b) => (a[sort] - b[sort]) * direction);
  }, [cards, query, recommendation, sort, sortDirection]);
  const estimatedValue = cards.reduce(
    (sum, card) => sum + card.marketPrice * card.quantity,
    0,
  );
  const potentialGain = cards.reduce(
    (sum, card) => sum + card.gain * card.quantity,
    0,
  );
  const auctionCards = cards
    .filter(
      (card) =>
        !card.marketOpportunity && !card.bidding && (card.auctionCount > 0 || card.listing),
    )
    ;
  const biddingCards = cards.filter((card) => card.bidding === true);
  const activeAuctionCount = cards.filter((card) => card.listing).length;
  const collectionCards = cards.filter(
    (card) => card.owned === true && card.listing !== true,
  );
  const opportunityCards = cards
    .filter((card) => card.marketOpportunity)
    .sort(
      (a, b) =>
        (b.qScore || b.score) - (a.qScore || a.score) ||
        a.marketPrice - b.marketPrice,
    );
  const visibleCards =
    activeTab === "opportunities" ? opportunityCards : collectionCards;
  const selectedPriceHistory = selectedCard?.cardId
    ? readPriceHistory(selectedCard.cardId)
    : [];
  const openMarket = (card: ScannerCard) => {
    const params = new URLSearchParams({
      page: "1",
      limit: "50",
      sort: "ending_soon",
      q: card.name,
    });
    chrome.tabs.create({
      url: `https://www.wiki-masters.com/marketplace?${params.toString()}`,
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Sparkles size={16} />
          </span>
          <div>
            <span className="brand-kicker">Wikimaster</span>Market Scanner
          </div>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-button"
            type="button"
            aria-label="Rafraîchir mes ventes"
            title="Rafraîchir mes ventes"
            onClick={refreshSales}
          >
            <RefreshCw size={17} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Recharger toute la collection"
            title="Recharger toute la collection"
            onClick={refreshCollection}
          >
            <PackageOpen size={17} />
          </button>
          <button
            className={`icon-button ${logsVisible ? "icon-button-active" : ""}`}
            type="button"
            aria-label="Afficher les logs"
            aria-expanded={logsVisible}
            onClick={() => setLogsVisible((visible) => !visible)}
          >
            <Terminal size={17} />
          </button>
          <button className="icon-button" type="button" aria-label="Réglages">
            <Settings2 size={17} />
          </button>
        </div>
      </header>
      <main className="content">
        <p className="eyebrow">
          <span />{" "}
          {dataSource === "wikimasters-api"
            ? "Synchronisé avec WikiMasters"
            : dataSource === "local-cache"
              ? "Cache local · actualisation en cours"
            : "Synchronisation en cours"}
        </p>
        <h1>Les cartes qui méritent votre attention.</h1>
        <p className="subtitle">
          Une vue nette de votre collection, des prix du marché et des ventes
          qui bougent maintenant.
        </p>
        <div className="hero-grid">
          <section className="metric-panel accent">
            <div className="metric-label">
              <span>Valeur estimée</span>
              <CircleDollarSign size={15} />
            </div>
            <strong className="metric-value">
              {(summaryValue ?? estimatedValue).toFixed(0)} Wikibidous
            </strong>
            <div className="metric-foot">
              <TrendingUp size={14} />{" "}
              {dataSource === "wikimasters-api"
                ? "Valeur fournie par WikiMasters"
                : "+14,2 % depuis votre dernière analyse"}
            </div>
          </section>
          <section className="metric-panel">
            <div className="metric-label">
              <span>Gain potentiel</span>
              <ArrowUpRight size={15} />
            </div>
            <strong className="metric-value">
              +{(summaryGain ?? potentialGain).toFixed(0)} Wikibidous
            </strong>
            <div className="metric-foot">
              sur {cards.length} cartes repérées
            </div>
          </section>
        </div>
        {syncError && (
          <div className="sync-notice">
            <span>{syncError}</span>
            <div className="sync-actions">
              <button type="button" onClick={openLogin}>
                Se connecter
              </button>
              <button
                type="button"
                onClick={() => {
                  setSyncError(null);
                  setDataSource("loading");
                  setRefreshToken((token) => token + 1);
                }}
              >
                Réessayer
              </button>
            </div>
          </div>
        )}
        {logsVisible && (
          <section className="logs-panel">
            <div className="logs-heading">
              <div>
                <Terminal size={14} />
                <strong>Logs de synchronisation</strong>
              </div>
              <button type="button" onClick={() => setLogs([])}>
                Effacer
              </button>
            </div>
            <div className="logs-content">
              {logs.length ? (
                logs.map((log, index) => (
                  <code key={`${log}-${index}`}>{log}</code>
                ))
              ) : (
                <span>Aucun log pour le moment.</span>
              )}
            </div>
          </section>
        )}
        <section>
          <div className="section-heading">
            <div>
              <h2>Ventes en cours</h2>
              <span>
                <Gavel size={12} /> {auctionCards.length} enchères suivies
              </span>
            </div>
            <div className="section-actions">
              <span>
                {isRefreshingSales ? (
                  <><span className="inline-loader" aria-hidden="true" /> Actualisation en cours</>
                ) : (
                  `Actualisation dans ${salesRefreshCountdown} s`
                )}
              </span>
              <button
                className="icon-button"
                type="button"
                onClick={refreshSales}
                aria-label="Rafraîchir les ventes en cours"
                title="Rafraîchir les ventes en cours"
              >
                <RefreshCw size={15} />
              </button>
            </div>
          </div>
          <div className="auction-strip">
            {auctionCards.length ? (
                auctionCards.map((card) => (
                <AuctionCard card={card} key={card.id} />
              ))
            ) : isRefreshingSales ? (
              <div className="empty-state loading-state"><span className="loader" aria-hidden="true" />Chargement des ventes…</div>
            ) : (
              <div className="empty-state">
                Aucune donnée de vente disponible.
              </div>
            )}
          </div>
        </section>
        <section>
          <div className="section-heading">
            <div>
              <h2>Achats en cours</h2>
              <span><Gavel size={12} /> {biddingCards.length} enchères surveillées</span>
            </div>
          </div>
          <div className="auction-strip">
            {biddingCards.length ? biddingCards.map((card) => (
              <AuctionCard card={card} key={card.id} onSelect={setBidCard} />
            )) : isRefreshingSales ? <div className="empty-state loading-state"><span className="loader" aria-hidden="true" />Chargement des achats…</div> : <div className="empty-state">Aucun achat en cours.</div>}
          </div>
        </section>
        <section>
          <div className="scanner-tabs">
            <button
              className={activeTab === "opportunities" ? "active" : ""}
              type="button"
              onClick={() => setActiveTab("opportunities")}
            >
              Top opportunités
            </button>
            <button
              className={activeTab === "collection" ? "active" : ""}
              type="button"
              onClick={() => setActiveTab("collection")}
            >
              Ma collection <span>{collectionCards.length}</span>
            </button>
            <button
              className={activeTab === "selling" ? "active" : ""}
              type="button"
              onClick={() => setActiveTab("selling")}
            >
              Mes ventes <span>{auctionCards.length}</span>
            </button>
          </div>
          {activeTab === "selling" ? (
            <div className="card-list">
              {auctionCards.length ? (
                auctionCards.map((card) => (
                  <CardRow
                    card={card}
                    key={card.id}
                    onSelect={setSelectedCard}
                  />
                ))
              ) : (
                <div className="empty-state">
                  Aucune mise en vente disponible.
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="section-heading">
                <h2>
                  {activeTab === "opportunities"
                    ? "Cartes à regarder"
                    : "Toutes mes cartes"}
                </h2>
                <span>
                  {
                    filteredCards.filter((card) =>
                      visibleCards.some(
                        (visibleCard) => visibleCard.id === card.id,
                      ),
                    ).length
                  }{" "}
                  résultats
                </span>
              </div>
              <div className="toolbar">
                <label className="search-box">
                  <Search size={15} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Rechercher une carte ou un set"
                  />
                </label>
                <button
                  className="filter-button"
                  type="button"
                  onClick={() => setShowFilters(!showFilters)}
                >
                  <SlidersHorizontal size={14} /> Filtrer
                </button>
                <select
                  className="sort-button"
                  value={sort}
                  onChange={(event) =>
                    {
                      setSort(event.target.value as typeof sort)
                      setSortDirection("desc")
                    }
                  }
                  aria-label="Trier les cartes"
                >
                  <option value="score">Score</option>
                  <option value="marketPrice">Prix</option>
                  <option value="gain">Gain</option>
                </select>
                <button
                  className="sort-direction-button"
                  type="button"
                  onClick={() =>
                    setSortDirection((direction) =>
                      direction === "asc" ? "desc" : "asc",
                    )
                  }
                  aria-label={`Ordre ${sortDirection === "asc" ? "croissant" : "décroissant"}`}
                  title={`Ordre ${sortDirection === "asc" ? "croissant" : "décroissant"}`}
                >
                  {sortDirection === "asc" ? "↑" : "↓"}
                </button>
              </div>
              {showFilters && (
                <div className="filter-bar">
                  <button
                    type="button"
                    className={recommendation === "ALL" ? "active" : ""}
                    onClick={() => setRecommendation("ALL")}
                  >
                    Toutes
                  </button>
                  <button
                    type="button"
                    className={recommendation === "SELL" ? "active" : ""}
                    onClick={() => setRecommendation("SELL")}
                  >
                    À vendre
                  </button>
                  <button
                    type="button"
                    className={recommendation === "WATCH" ? "active" : ""}
                    onClick={() => setRecommendation("WATCH")}
                  >
                    À surveiller
                  </button>
                  <span>
                    <Clock3 size={13} /> Prix mis à jour avec les données
                    disponibles
                  </span>
                </div>
              )}
              <div className="card-list">
                {filteredCards.filter((card) =>
                  visibleCards.some(
                    (visibleCard) => visibleCard.id === card.id,
                  ),
                ).length ? (
                  filteredCards
                    .filter((card) =>
                      visibleCards.some(
                        (visibleCard) => visibleCard.id === card.id,
                      ),
                    )
                    .map((card) => (
                      <CardRow
                        card={card}
                        key={card.id}
                        onSelect={setSelectedCard}
                      />
                    ))
                ) : (
                  <div className="empty-state">
                    {isLoadingCollection && activeTab === "collection" ? (
                      <span className="loading-state"><span className="loader" aria-hidden="true" />Chargement de la collection…</span>
                    ) : isLoadingMarketplace && activeTab === "opportunities" ? (
                      <span className="loading-state"><span className="loader" aria-hidden="true" />Recherche des opportunités…</span>
                    ) : syncError
                      ? "Aucune donnée de carte disponible."
                      : activeTab === "opportunities"
                        ? "Aucune estimation de prix disponible pour le moment."
                        : "Aucune carte ne correspond à cette recherche."}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </main>
      {selectedCard && (
        <div
          className="detail-overlay"
          role="presentation"
          onClick={() => setSelectedCard(null)}
        >
          <aside
            className="detail-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="icon-button close-button"
              onClick={() => setSelectedCard(null)}
              aria-label="Fermer"
              type="button"
            >
              <X size={17} />
            </button>
            <p className="eyebrow">
              <span /> Détail de la carte
            </p>
            <h2>{selectedCard.name}</h2>
            <p className="detail-subtitle">
              {selectedCard.number} · {selectedCard.set}
            </p>
            <div className="detail-price">
              <span>Prix marché actuel</span>
              <strong>
                {selectedCard.marketPrice.toFixed(2).replace(".", ",")}{" "}
                Wikibidous
              </strong>
              <small>
                {selectedCard.priceLoading && (
                  <span className="inline-loader" aria-hidden="true" />
                )}
                +{selectedCard.trend}% sur 30 jours
              </small>
            </div>
            <div className="price-history">
              <div className="price-history-heading">
                <span>Historique des prix</span>
                <small>30 derniers relevés en cache</small>
              </div>
              {selectedPriceHistory.length ? (
                <div className="price-history-list">
                  {[...selectedPriceHistory].reverse().map((point, index) => (
                    <div className="price-history-row" key={`${point.at}-${index}`}>
                      <span>{formatPricePointDate(point.at)}</span>
                      <strong>{point.price.toFixed(2).replace(".", ",")} Wikibidous</strong>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="price-history-empty">Aucun relevé en cache.</p>
              )}
            </div>
            <div className="detail-stats">
              <div>
                <span>Votre quantité</span>
                <strong>{selectedCard.quantity}</strong>
              </div>
              {selectedCard.purchasePrice !== undefined && (
                <div>
                  <span>Prix d’achat</span>
                  <strong>{selectedCard.purchasePrice.toFixed(0)} Wikibidous</strong>
                </div>
              )}
              <div>
                <span>Liquidité</span>
                <strong>
                  {selectedCard.liquidity === "high" ? "Élevée" : "Moyenne"}
                </strong>
              </div>
              <div>
                <span>Meilleure offre</span>
                <strong>{selectedCard.highestBid ?? "—"} Wikibidous</strong>
              </div>
              <div>
                <span>Score</span>
                <strong>{selectedCard.qScore ?? selectedCard.score}/100</strong>
              </div>
            </div>
            {selectedCard.owned && selectedCard.cardId ? (
              <button
                className="detail-cta"
                type="button"
                onClick={() => setAuctionCard(selectedCard)}
              >
                Ajouter aux enchères <Gavel size={16} />
              </button>
            ) : null}
            <button
              className="detail-cta detail-market-cta"
              type="button"
              onClick={() => openMarket(selectedCard)}
            >
              Ouvrir le marché <ArrowUpRight size={16} />
            </button>
          </aside>
        </div>
      )}
      {auctionCard && (
        <div
          className="auction-form-overlay"
          role="presentation"
          onClick={() => setAuctionCard(null)}
        >
          <div onClick={(event) => event.stopPropagation()}>
            <AuctionForm
              activeCount={activeAuctionCount}
              initialBaseAmount={
                auctionCard.marketPrice > 0
                  ? Math.round(auctionCard.marketPrice)
                  : 100
              }
              onSubmit={(baseAmount, durationMinutes) =>
                createAuction(auctionCard, baseAmount, durationMinutes)
              }
            />
          </div>
        </div>
      )}
      {bidCard && <BidDialog card={bidCard} onCancel={() => setBidCard(null)} onSubmit={(amount) => placeBid(bidCard, amount)} />}
    </div>
  );
}

export default App;
