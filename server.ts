import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type TripType = 'ONE_WAY' | 'ROUND_TRIP';

type ParsedDateTime = {
  date: string;
  time: string;
};

type AirportLocation = {
  iata: string;
  city: string;
  country: string;
  aliases: string[];
  connections: string[];
  isFakeStation: boolean;
  latitude?: number;
  longitude?: number;
};

type WikipediaSummary = {
  photoUrl?: string;
  latitude?: number;
  longitude?: number;
};

type SimpleLeg = {
  origin: string;
  originIata: string;
  destination: string;
  destinationIata: string;
  departureDate: string;
  departureTime: string;
  arrivalDate: string;
  arrivalTime: string;
  price: number;
  currency: string;
};

const parseDateAndTime = (isoDateTime: unknown): ParsedDateTime | null => {
  if (typeof isoDateTime !== 'string' || !isoDateTime.includes('T')) return null;
  const [datePart, timePart = '00:00'] = isoDateTime.split('T');
  if (!datePart) return null;
  return { date: datePart, time: timePart.slice(0, 5) || '00:00' };
};

const RYANAIR_FAREFINDER_ENDPOINT = 'https://www.ryanair.com/api/farfnd/v4/oneWayFares';
const MAX_FARE_PAGES = 10;
const WIZZ_FAREFINDER_PAGE_URL = 'https://www.wizzair.com/en-gb/flights/fare-finder';
const WIZZ_API_BASE_URL_FALLBACK = 'https://be.wizzair.com/28.6.0/Api';
const WIZZ_SMART_SEARCH_PATHS = ['/search/SmartSearchCheapFlightsV2', '/search/SmartSearchCheapFlights'];
const WIZZ_API_URL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const WIZZ_AIRPORTS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const WIKIPEDIA_SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const ANY_ORIGIN_CANDIDATES = ['STN', 'LIS', 'OPO', 'MAD', 'BCN', 'DUB', 'BGY', 'BVA'];
const ANY_ORIGIN_CANDIDATES_ROUND_TRIP_LIMIT = 5;

let cachedWizzApiBaseUrl: string | null = null;
let cachedWizzApiBaseUrlExpiresAt = 0;
let cachedWizzAirports = new Map<string, AirportLocation>();
let cachedWizzAirportsExpiresAt = 0;
const wikipediaSummaryCache = new Map<string, WikipediaSummary | null>();

const decodeWizzEscapedUrl = (value: string) =>
  value
    .replace(/\\u002F/g, '/')
    .replace(/\\u003A/g, ':');

const isDateOnly = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const normalizeDateOnly = (value: unknown, fallback: string) => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return isDateOnly(trimmed) ? trimmed : fallback;
};

const formatDateOnlyLocal = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatTimeLocal = (date: Date) => {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
};

const estimateArrivalFromDuration = (departureIsoDateTime: unknown, durationMinutes: unknown): ParsedDateTime | null => {
  if (typeof departureIsoDateTime !== 'string') return null;
  const duration = Number(durationMinutes);
  if (!Number.isFinite(duration) || duration <= 0) return null;

  const departure = new Date(departureIsoDateTime);
  if (Number.isNaN(departure.getTime())) return null;

  const arrival = new Date(departure.getTime() + duration * 60 * 1000);
  return {
    date: formatDateOnlyLocal(arrival),
    time: formatTimeLocal(arrival)
  };
};

const roundPrice = (value: number) => Number(value.toFixed(2));

const toIata = (value: unknown) => String(value ?? '').trim().toUpperCase();

const normalizeSearchText = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const scoreAirportSearch = (airport: AirportLocation, query: string) => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return -1;

  const iata = normalizeSearchText(airport.iata);
  const city = normalizeSearchText(airport.city);
  const country = normalizeSearchText(airport.country || '');
  const aliases = airport.aliases.map(normalizeSearchText);

  if (iata === normalizedQuery) return 1000;
  if (iata.startsWith(normalizedQuery)) return 920;
  if (city === normalizedQuery) return 900;
  if (aliases.includes(normalizedQuery)) return 860;
  if (country === normalizedQuery) return 840;
  if (city.startsWith(normalizedQuery)) return 760;
  if (aliases.some((alias) => alias.startsWith(normalizedQuery))) return 700;
  if (country.startsWith(normalizedQuery)) return 660;
  if (iata.includes(normalizedQuery)) return 620;
  if (city.includes(normalizedQuery)) return 580;
  if (aliases.some((alias) => alias.includes(normalizedQuery))) return 540;
  if (country.includes(normalizedQuery)) return 500;
  return -1;
};

const haversineKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const toRadians = (deg: number) => (deg * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
};

const tileFromLatLon = (lat: number, lon: number, zoom: number) => {
  const latRad = (lat * Math.PI) / 180;
  const scale = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * scale);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale
  );
  return { x, y };
};

const createMapAssets = (latitude: number | undefined, longitude: number | undefined, label: string) => {
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const lat = Number(latitude);
    const lon = Number(longitude);
    const zoom = 7;
    const tile = tileFromLatLon(lat, lon, zoom);

    return {
      destinationMapUrl: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=10/${lat}/${lon}`,
      destinationMapEmbedUrl:
        `https://www.openstreetmap.org/export/embed.html?bbox=${lon - 0.35}%2C${lat - 0.22}%2C${lon + 0.35}%2C${lat + 0.22}` +
        `&layer=mapnik&marker=${lat}%2C${lon}`,
      destinationPreviewImageUrl: `https://tile.openstreetmap.org/${zoom}/${tile.x}/${tile.y}.png`
    };
  }

  const query = encodeURIComponent(label);
  return {
    destinationMapUrl: `https://www.google.com/maps/search/?api=1&query=${query}`,
    destinationMapEmbedUrl: `https://www.google.com/maps?q=${query}&output=embed`,
    destinationPreviewImageUrl: undefined
  };
};

const fetchRyanairFares = async (params: Record<string, string>): Promise<any[]> => {
  const fares: any[] = [];
  let nextPage: number | null = null;
  const visitedPages = new Set<number>();

  for (let i = 0; i < MAX_FARE_PAGES; i++) {
    const pageParams: Record<string, string> = { ...params };
    if (nextPage !== null) {
      pageParams.pageNumber = String(nextPage);
    }

    const response = await axios.get(RYANAIR_FAREFINDER_ENDPOINT, {
      params: pageParams,
      timeout: 12000
    });

    const pageFares = Array.isArray(response.data?.fares) ? response.data.fares : [];
    fares.push(...pageFares);

    const rawNextPage = response.data?.nextPage;
    if (rawNextPage === null || rawNextPage === undefined) {
      break;
    }

    const parsedNextPage = Number(rawNextPage);
    if (!Number.isFinite(parsedNextPage) || visitedPages.has(parsedNextPage)) {
      break;
    }

    visitedPages.add(parsedNextPage);
    nextPage = parsedNextPage;
  }

  return fares;
};

const parseRyanairFareLeg = (fare: any): SimpleLeg | null => {
  const outbound = fare?.outbound;
  const summaryPrice = Number(fare?.summary?.price?.value);
  const outboundPrice = Number(outbound?.price?.value);
  const totalPrice = Number.isFinite(summaryPrice) ? summaryPrice : outboundPrice;
  const departure = parseDateAndTime(outbound?.departureDate);
  const arrival = parseDateAndTime(outbound?.arrivalDate);

  if (!outbound || !departure || !arrival || !Number.isFinite(totalPrice)) {
    return null;
  }

  const originIata = toIata(outbound?.departureAirport?.iataCode);
  const destinationIata = toIata(outbound?.arrivalAirport?.iataCode);

  if (!originIata || !destinationIata) {
    return null;
  }

  return {
    origin: outbound?.departureAirport?.name || originIata,
    originIata,
    destination: outbound?.arrivalAirport?.name || destinationIata,
    destinationIata,
    departureDate: departure.date,
    departureTime: departure.time,
    arrivalDate: arrival.date,
    arrivalTime: arrival.time,
    price: roundPrice(totalPrice),
    currency: outbound?.price?.currencyCode || 'EUR'
  };
};

const parseWizzItemLeg = (item: any): SimpleLeg | null => {
  const flight = item?.outboundFlight ?? item;
  const departure = parseDateAndTime(flight?.std ?? item?.std);
  if (!departure) {
    return null;
  }

  const originIata = toIata(flight?.departureStation ?? item?.departureStation);
  const destinationIata = toIata(flight?.arrivalStation ?? item?.arrivalStation);
  if (!originIata || !destinationIata) {
    return null;
  }

  const rawPrice = Number(
    flight?.regularPrice?.amount
    ?? item?.regularPrice?.amount
    ?? flight?.wdcPrice?.amount
    ?? item?.wdcPrice?.amount
  );
  if (!Number.isFinite(rawPrice)) {
    return null;
  }

  const arrival = estimateArrivalFromDuration(
    flight?.std ?? item?.std,
    flight?.flightDurationMinutes ?? item?.flightDurationMinutes
  ) ?? departure;

  return {
    origin: originIata,
    originIata,
    destination: destinationIata,
    destinationIata,
    departureDate: departure.date,
    departureTime: departure.time,
    arrivalDate: arrival.date,
    arrivalTime: arrival.time,
    price: roundPrice(rawPrice),
    currency: flight?.regularPrice?.currencyCode || item?.currencyCode || 'EUR'
  };
};

const buildRyanairBookingUrl = (options: {
  adults: number;
  dateOut: string;
  originOut: string;
  arrivalOut: string;
  isReturn: boolean;
  dateIn?: string;
  originIn?: string;
  arrivalIn?: string;
}) => {
  const {
    adults,
    dateOut,
    originOut,
    arrivalOut,
    isReturn,
    dateIn,
    originIn,
    arrivalIn
  } = options;

  const url = new URL('https://www.ryanair.com/gb/en/trip/flights/select');

  const setBoth = (key: string, value: string, tpKey: string) => {
    url.searchParams.set(key, value);
    url.searchParams.set(tpKey, value);
  };

  setBoth('adults', String(adults), 'tpAdults');
  setBoth('teens', '0', 'tpTeens');
  setBoth('children', '0', 'tpChildren');
  setBoth('infants', '0', 'tpInfants');
  setBoth('dateOut', dateOut, 'tpStartDate');
  setBoth('originOut', originOut, 'tpOriginOut');
  setBoth('arrivalOut', arrivalOut, 'tpArrivalOut');
  setBoth('isReturn', isReturn ? 'true' : 'false', 'tpIsReturn');

  if (isReturn && dateIn && originIn && arrivalIn) {
    setBoth('dateIn', dateIn, 'tpEndDate');
    setBoth('originIn', originIn, 'tpOriginIn');
    setBoth('arrivalIn', arrivalIn, 'tpArrivalIn');
  }

  return url.toString();
};

const buildWizzBookingUrl = (options: {
  originOut: string;
  arrivalOut: string;
  dateOut: string;
  adults: number;
  originIn?: string;
  arrivalIn?: string;
  dateIn?: string;
}) => {
  const {
    originOut,
    arrivalOut,
    dateOut,
    adults,
    originIn,
    arrivalIn,
    dateIn
  } = options;

  const safe = encodeURIComponent;

  if (originIn && arrivalIn && dateIn) {
    return `https://www.wizzair.com/en-gb/booking/select-flight/${safe(originOut)}/${safe(arrivalOut)}/${safe(dateOut)}/${safe(originIn)}/${safe(arrivalIn)}/${safe(dateIn)}/${adults}/0/0/null`;
  }

  return `https://www.wizzair.com/en-gb/booking/select-flight/${safe(originOut)}/${safe(arrivalOut)}/${safe(dateOut)}/null/${adults}/0/0/null`;
};

const discoverWizzApiBaseUrl = async (): Promise<string | null> => {
  const now = Date.now();
  if (cachedWizzApiBaseUrl && cachedWizzApiBaseUrlExpiresAt > now) {
    return cachedWizzApiBaseUrl;
  }

  try {
    const response = await axios.get(WIZZ_FAREFINDER_PAGE_URL, {
      timeout: 10000,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
        'User-Agent': 'Mozilla/5.0'
      }
    });

    const html = typeof response.data === 'string' ? response.data : '';
    const encodedMatch = html.match(/https:\\u002F\\u002Fbe\.wizzair\.com\\u002F[0-9.]+\\u002FApi/i);
    const plainMatch = html.match(/https:\/\/be\.wizzair\.com\/[0-9.]+\/Api/i);
    const detectedBaseUrl = encodedMatch
      ? decodeWizzEscapedUrl(encodedMatch[0])
      : plainMatch?.[0] ?? null;

    if (!detectedBaseUrl) {
      return null;
    }

    cachedWizzApiBaseUrl = detectedBaseUrl;
    cachedWizzApiBaseUrlExpiresAt = now + WIZZ_API_URL_CACHE_TTL_MS;
    return detectedBaseUrl;
  } catch (error: any) {
    console.error('Failed to discover Wizz API base URL:', error.message);
    return null;
  }
};

const getWizzApiBaseCandidates = async () => {
  const discoveredBaseUrl = await discoverWizzApiBaseUrl();
  return Array.from(new Set([discoveredBaseUrl, WIZZ_API_BASE_URL_FALLBACK].filter(Boolean))) as string[];
};

const fetchWizzAirportMap = async (): Promise<Map<string, AirportLocation>> => {
  const now = Date.now();
  if (cachedWizzAirports.size > 0 && cachedWizzAirportsExpiresAt > now) {
    return cachedWizzAirports;
  }

  const candidates = await getWizzApiBaseCandidates();

  for (const baseUrl of candidates) {
    try {
      const response = await axios.get(`${baseUrl}/asset/map`, {
        timeout: 12000,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-GB,en;q=0.9',
          Origin: 'https://www.wizzair.com',
          Referer: 'https://www.wizzair.com/',
          'User-Agent': 'Mozilla/5.0'
        }
      });

      const cities = Array.isArray(response.data?.cities) ? response.data.cities : [];
      const map = new Map<string, AirportLocation>();

      for (const city of cities) {
        const iata = toIata(city?.iata);
        if (!iata) continue;

        const lat = Number(city?.latitude);
        const lon = Number(city?.longitude);
        const aliases = Array.isArray(city?.aliases)
          ? city.aliases.map((alias: any) => String(alias || '').trim()).filter(Boolean)
          : [];
        const connections = Array.isArray(city?.connections)
          ? city.connections
            .map((connection: any) => toIata(connection?.iata))
            .filter(Boolean)
          : [];

        map.set(iata, {
          iata,
          city: String(city?.shortName || city?.aliases?.[0] || iata),
          country: String(city?.countryName || city?.countryCode || ''),
          aliases,
          connections,
          isFakeStation: Boolean(city?.isFakeStation),
          latitude: Number.isFinite(lat) ? lat : undefined,
          longitude: Number.isFinite(lon) ? lon : undefined
        });
      }

      if (map.size > 0) {
        cachedWizzAirports = map;
        cachedWizzAirportsExpiresAt = now + WIZZ_AIRPORTS_CACHE_TTL_MS;
      }

      return cachedWizzAirports;
    } catch (error: any) {
      console.error(`Failed to fetch Wizz airport map from ${baseUrl}:`, error.message);
    }
  }

  return cachedWizzAirports;
};

const fetchWikipediaSummary = async (query: string): Promise<WikipediaSummary | null> => {
  const normalizedKey = query.trim().toLowerCase();
  if (!normalizedKey) return null;

  if (wikipediaSummaryCache.has(normalizedKey)) {
    return wikipediaSummaryCache.get(normalizedKey) ?? null;
  }

  try {
    const title = encodeURIComponent(query.trim().replace(/\s+/g, '_'));
    const response = await axios.get(`${WIKIPEDIA_SUMMARY_URL}/${title}`, {
      timeout: 5000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'lowfare-finder/1.0'
      }
    });

    const lat = Number(response.data?.coordinates?.lat);
    const lon = Number(response.data?.coordinates?.lon);

    const summary: WikipediaSummary = {
      photoUrl: response.data?.thumbnail?.source,
      latitude: Number.isFinite(lat) ? lat : undefined,
      longitude: Number.isFinite(lon) ? lon : undefined
    };

    wikipediaSummaryCache.set(normalizedKey, summary);
    return summary;
  } catch {
    wikipediaSummaryCache.set(normalizedKey, null);
    return null;
  }
};

const buildDestinationContext = async (destinationIata: string, destinationName: string) => {
  const airports = await fetchWizzAirportMap();
  const known = airports.get(toIata(destinationIata));

  const destinationCity = known?.city || destinationName || destinationIata;
  const destinationCountry = known?.country || undefined;

  let destinationLatitude = known?.latitude;
  let destinationLongitude = known?.longitude;

  let wiki = await fetchWikipediaSummary(destinationCity);
  if (!wiki && destinationCountry) {
    wiki = await fetchWikipediaSummary(`${destinationCity}, ${destinationCountry}`);
  }

  if (!Number.isFinite(destinationLatitude) && Number.isFinite(wiki?.latitude)) {
    destinationLatitude = wiki?.latitude;
  }
  if (!Number.isFinite(destinationLongitude) && Number.isFinite(wiki?.longitude)) {
    destinationLongitude = wiki?.longitude;
  }

  const label = [destinationCity, destinationCountry].filter(Boolean).join(', ');
  const maps = createMapAssets(destinationLatitude, destinationLongitude, label || destinationIata);

  return {
    destinationCity,
    destinationCountry,
    destinationLatitude,
    destinationLongitude,
    destinationPhotoUrl: wiki?.photoUrl,
    destinationPreviewImageUrl: maps.destinationPreviewImageUrl,
    destinationMapUrl: maps.destinationMapUrl,
    destinationMapEmbedUrl: maps.destinationMapEmbedUrl
  };
};

const enrichDealsWithLocation = async (deals: any[]) => {
  const contextByIata = new Map<string, any>();

  for (const deal of deals) {
    const iata = toIata(deal.destinationIata);
    if (!iata || contextByIata.has(iata)) continue;
    const context = await buildDestinationContext(iata, String(deal.destination || iata));
    contextByIata.set(iata, context);
  }

  return deals.map((deal) => ({
    ...deal,
    ...(contextByIata.get(toIata(deal.destinationIata)) || {})
  }));
};

const fetchWizzSmartSearchItems = async (options: {
  originIata: string;
  passengerCount: number;
  arrivalIatas?: string[] | null;
  departureDate?: string | null;
  dateFilterType?: 'Exact' | 'Flexible';
}): Promise<any[]> => {
  const {
    originIata,
    passengerCount,
    arrivalIatas = null,
    departureDate = null,
    dateFilterType = 'Flexible'
  } = options;

  const payload = {
    departureStations: [originIata],
    arrivalStations: arrivalIatas,
    stdPlan: null,
    isReturnFlight: false,
    tripDuration: 'anytime',
    pax: passengerCount,
    dateFilterType,
    departureDate: dateFilterType === 'Exact' ? departureDate : null,
    returnDate: null
  };

  let lastError: any = null;
  const baseUrlCandidates = await getWizzApiBaseCandidates();

  for (const baseUrl of baseUrlCandidates) {
    for (const endpointPath of WIZZ_SMART_SEARCH_PATHS) {
      try {
        const response = await axios.post(`${baseUrl}${endpointPath}`, payload, {
          timeout: 12000,
          headers: {
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'en-GB,en;q=0.9',
            'Content-Type': 'application/json',
            Origin: 'https://www.wizzair.com',
            Referer: 'https://www.wizzair.com/',
            'User-Agent': 'Mozilla/5.0'
          }
        });

        cachedWizzApiBaseUrl = baseUrl;
        cachedWizzApiBaseUrlExpiresAt = Date.now() + WIZZ_API_URL_CACHE_TTL_MS;

        return Array.isArray(response.data?.items) ? response.data.items : [];
      } catch (error: any) {
        lastError = error;
        const status = error?.response?.status;
        const endpointLabel = `${baseUrl}${endpointPath}`;
        if (status === 404 || status === 403) {
          console.error(`Wizz endpoint blocked/unavailable (${status}) on ${endpointLabel}. Trying next...`);
          continue;
        }
        console.error(`Wizz endpoint failed on ${endpointLabel}:`, error.message);
      }
    }
  }

  throw lastError ?? new Error('All Wizz SmartSearch endpoints failed');
};

async function startServer() {
  const app = express();
  const PORT = 3000;
  const corsOrigin = process.env.CORS_ORIGIN || '*';

  app.use(express.json());
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    next();
  });

  app.get('/api/airports/nearby', async (req, res) => {
    try {
      const lat = Number(req.query.lat);
      const lon = Number(req.query.lon);
      const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '12'), 10) || 12));

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return res.status(400).json({ error: 'Invalid coordinates' });
      }

      const airports = await fetchWizzAirportMap();
      const list = Array.from(airports.values())
        .filter(
          (airport) =>
            !airport.isFakeStation &&
            Number.isFinite(airport.latitude) &&
            Number.isFinite(airport.longitude)
        )
        .map((airport) => {
          const distanceKm = haversineKm(lat, lon, Number(airport.latitude), Number(airport.longitude));
          return {
            iata: airport.iata,
            city: airport.city,
            country: airport.country,
            latitude: airport.latitude,
            longitude: airport.longitude,
            distanceKm: roundPrice(distanceKm)
          };
        })
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, limit);

      res.json({ airports: list });
    } catch (error: any) {
      console.error('Error fetching nearby airports:', error.message);
      res.status(500).json({ error: 'Failed to fetch nearby airports', details: error.message });
    }
  });

  app.get('/api/airports/search', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const limit = Math.min(30, Math.max(1, parseInt(String(req.query.limit || '10'), 10) || 10));

      if (!q) {
        return res.json({ airports: [] });
      }

      const airports = await fetchWizzAirportMap();
      const results = Array.from(airports.values())
        .filter((airport) => !airport.isFakeStation)
        .map((airport) => ({
          airport,
          score: scoreAirportSearch(airport, q)
        }))
        .filter((item) => item.score >= 0)
        .sort((a, b) =>
          b.score - a.score
          || b.airport.connections.length - a.airport.connections.length
          || a.airport.city.localeCompare(b.airport.city)
          || a.airport.iata.localeCompare(b.airport.iata)
        )
        .slice(0, limit)
        .map(({ airport }) => ({
          iata: airport.iata,
          city: airport.city,
          country: airport.country,
          latitude: airport.latitude,
          longitude: airport.longitude,
          outboundCount: airport.connections.length,
          label: `${airport.city}${airport.country ? `, ${airport.country}` : ''} (${airport.iata})`
        }));

      res.json({ airports: results });
    } catch (error: any) {
      console.error('Error searching airports:', error.message);
      res.status(500).json({ error: 'Failed to search airports', details: error.message });
    }
  });

  app.get('/api/deals', async (req, res) => {
    try {
      const {
        origin,
        maxPrice,
        adults = 1,
        airline = 'ALL',
        tripType = 'ONE_WAY',
        departureDate,
        returnDate
      } = req.query;

      const airlineCode = typeof airline === 'string' ? airline.trim().toUpperCase() : 'ALL';
      const normalizedTripType: TripType = String(tripType).trim().toUpperCase() === 'ROUND_TRIP' ? 'ROUND_TRIP' : 'ONE_WAY';
      const isRoundTrip = normalizedTripType === 'ROUND_TRIP';

      const passengerCount = Math.min(10, Math.max(1, parseInt(String(adults), 10) || 1));
      const rawOrigin = typeof origin === 'string' ? origin.trim().toUpperCase() : 'ANY';
      const safeOrigin = rawOrigin === 'ANY' || /^[A-Z]{3}$/.test(rawOrigin) ? rawOrigin : 'ANY';
      const originCandidates = safeOrigin === 'ANY'
        ? (
          isRoundTrip
            ? ANY_ORIGIN_CANDIDATES.slice(0, ANY_ORIGIN_CANDIDATES_ROUND_TRIP_LIMIT)
            : ANY_ORIGIN_CANDIDATES
        )
        : [safeOrigin];
      const priceCap = parseFloat(String(maxPrice));
      const hasValidPriceCap = Number.isFinite(priceCap) && priceCap > 0;

      const today = new Date();
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
      const defaultDepartureDate = formatDateOnlyLocal(tomorrow);
      const defaultReturnDate = formatDateOnlyLocal(new Date(today.getTime() + 8 * 24 * 60 * 60 * 1000));
      const safeDepartureDate = normalizeDateOnly(departureDate, defaultDepartureDate);
      const safeReturnDate = normalizeDateOnly(returnDate, defaultReturnDate);

      if (isRoundTrip && safeReturnDate < safeDepartureDate) {
        return res.json({
          deals: [],
          message: 'A data de volta deve ser igual ou posterior à data de ida.'
        });
      }

      type SupportedAirline = 'RYANAIR' | 'WIZZ';
      const normalizedAirlineCode = ['RYANAIR', 'WIZZ', 'ALL'].includes(airlineCode) ? airlineCode : 'ALL';

      const fetchDealsForAirline = async (currentAirline: SupportedAirline, originIata: string) => {
        if (currentAirline === 'WIZZ') {
          const outboundItems = await fetchWizzSmartSearchItems({
            originIata,
            passengerCount,
            dateFilterType: 'Exact',
            departureDate: safeDepartureDate
          });

          const outboundLegs = outboundItems
            .map(parseWizzItemLeg)
            .filter(Boolean) as SimpleLeg[];

          if (!isRoundTrip) {
            return outboundLegs
              .map((leg) => ({
                airline: 'Wizz Air',
                tripType: 'ONE_WAY',
                type: 'Basic / WIZZ Go Light',
                baggage: 'Small Cabin Bag (40x30x20cm)',
                price: leg.price,
                outboundPrice: leg.price,
                pricePerPerson: roundPrice(leg.price / passengerCount),
                currency: leg.currency,
                origin: leg.origin,
                originIata: leg.originIata,
                destination: leg.destination,
                destinationIata: leg.destinationIata,
                departureDate: leg.departureDate,
                departureTime: leg.departureTime,
                arrivalDate: leg.arrivalDate,
                arrivalTime: leg.arrivalTime,
                link: buildWizzBookingUrl({
                  originOut: leg.originIata,
                  arrivalOut: leg.destinationIata,
                  dateOut: leg.departureDate,
                  adults: passengerCount
                }),
                status: 'Available'
              }))
              .filter((deal) => !hasValidPriceCap || deal.price <= priceCap);
          }

          const uniqueOutboundByDestination = Array.from(
            new Map(outboundLegs.map((leg) => [leg.destinationIata, leg])).values()
          )
            .sort((a, b) => a.price - b.price)
            .slice(0, 12);

          const paired = await Promise.all(
            uniqueOutboundByDestination.map(async (outbound) => {
              try {
                const returnItems = await fetchWizzSmartSearchItems({
                  originIata: outbound.destinationIata,
                  arrivalIatas: [originIata],
                  passengerCount,
                  dateFilterType: 'Exact',
                  departureDate: safeReturnDate
                });

                const returnLeg = returnItems
                  .map(parseWizzItemLeg)
                  .filter((leg): leg is SimpleLeg => Boolean(leg) && leg.destinationIata === originIata)
                  .sort((a, b) => a.price - b.price)[0];

                if (!returnLeg) return null;

                const totalPrice = roundPrice(outbound.price + returnLeg.price);
                if (hasValidPriceCap && totalPrice > priceCap) return null;

                return {
                  airline: 'Wizz Air',
                  tripType: 'ROUND_TRIP',
                  type: 'Basic / WIZZ Go Light',
                  baggage: 'Small Cabin Bag (40x30x20cm)',
                  price: totalPrice,
                  outboundPrice: outbound.price,
                  returnPrice: returnLeg.price,
                  pricePerPerson: roundPrice(totalPrice / passengerCount),
                  currency: outbound.currency,
                  origin: outbound.origin,
                  originIata: outbound.originIata,
                  destination: outbound.destination,
                  destinationIata: outbound.destinationIata,
                  departureDate: outbound.departureDate,
                  departureTime: outbound.departureTime,
                  arrivalDate: outbound.arrivalDate,
                  arrivalTime: outbound.arrivalTime,
                  returnDate: returnLeg.departureDate,
                  returnTime: returnLeg.departureTime,
                  returnArrivalDate: returnLeg.arrivalDate,
                  returnArrivalTime: returnLeg.arrivalTime,
                  link: buildWizzBookingUrl({
                    originOut: outbound.originIata,
                    arrivalOut: outbound.destinationIata,
                    dateOut: outbound.departureDate,
                    originIn: outbound.destinationIata,
                    arrivalIn: outbound.originIata,
                    dateIn: returnLeg.departureDate,
                    adults: passengerCount
                  }),
                  status: 'Available'
                };
              } catch {
                return null;
              }
            })
          );

          return paired.filter(Boolean);
        }

        const outboundQuery: Record<string, string> = {
          departureAirportIataCode: originIata,
          outboundDepartureDateFrom: safeDepartureDate,
          outboundDepartureDateTo: safeDepartureDate,
          market: 'en-gb',
          adultPaxCount: String(passengerCount)
        };

        if (hasValidPriceCap && !isRoundTrip) {
          outboundQuery.priceValueTo = String(priceCap);
          outboundQuery.currency = 'EUR';
        }

        const outboundFares = await fetchRyanairFares(outboundQuery);
        const outboundLegs = outboundFares
          .map(parseRyanairFareLeg)
          .filter(Boolean) as SimpleLeg[];

        if (!isRoundTrip) {
          return outboundLegs
            .map((leg) => ({
              airline: 'Ryanair',
              tripType: 'ONE_WAY',
              type: 'Basic / Value',
              baggage: 'Small Backpack (40x20x25cm)',
              price: leg.price,
              outboundPrice: leg.price,
              pricePerPerson: roundPrice(leg.price / passengerCount),
              currency: leg.currency,
              origin: leg.origin,
              originIata: leg.originIata,
              destination: leg.destination,
              destinationIata: leg.destinationIata,
              departureDate: leg.departureDate,
              departureTime: leg.departureTime,
              arrivalDate: leg.arrivalDate,
              arrivalTime: leg.arrivalTime,
              link: buildRyanairBookingUrl({
                adults: passengerCount,
                dateOut: leg.departureDate,
                originOut: leg.originIata,
                arrivalOut: leg.destinationIata,
                isReturn: false
              }),
              status: 'Available'
            }))
            .filter((deal) => !hasValidPriceCap || deal.price <= priceCap);
        }

        const uniqueOutboundByDestination = Array.from(
          new Map(outboundLegs.map((leg) => [leg.destinationIata, leg])).values()
        )
          .sort((a, b) => a.price - b.price)
          .slice(0, 12);

        const paired = await Promise.all(
          uniqueOutboundByDestination.map(async (outbound) => {
            try {
              const returnQuery: Record<string, string> = {
                departureAirportIataCode: outbound.destinationIata,
                arrivalAirportIataCode: originIata,
                outboundDepartureDateFrom: safeReturnDate,
                outboundDepartureDateTo: safeReturnDate,
                market: 'en-gb',
                adultPaxCount: String(passengerCount)
              };

              const returnFares = await fetchRyanairFares(returnQuery);
              const returnLeg = returnFares
                .map(parseRyanairFareLeg)
                .filter((leg): leg is SimpleLeg => Boolean(leg) && leg.destinationIata === originIata)
                .sort((a, b) => a.price - b.price)[0];

              if (!returnLeg) return null;

              const totalPrice = roundPrice(outbound.price + returnLeg.price);
              if (hasValidPriceCap && totalPrice > priceCap) return null;

              return {
                airline: 'Ryanair',
                tripType: 'ROUND_TRIP',
                type: 'Basic / Value',
                baggage: 'Small Backpack (40x20x25cm)',
                price: totalPrice,
                outboundPrice: outbound.price,
                returnPrice: returnLeg.price,
                pricePerPerson: roundPrice(totalPrice / passengerCount),
                currency: outbound.currency,
                origin: outbound.origin,
                originIata: outbound.originIata,
                destination: outbound.destination,
                destinationIata: outbound.destinationIata,
                departureDate: outbound.departureDate,
                departureTime: outbound.departureTime,
                arrivalDate: outbound.arrivalDate,
                arrivalTime: outbound.arrivalTime,
                returnDate: returnLeg.departureDate,
                returnTime: returnLeg.departureTime,
                returnArrivalDate: returnLeg.arrivalDate,
                returnArrivalTime: returnLeg.arrivalTime,
                link: buildRyanairBookingUrl({
                  adults: passengerCount,
                  dateOut: outbound.departureDate,
                  dateIn: returnLeg.departureDate,
                  originOut: outbound.originIata,
                  arrivalOut: outbound.destinationIata,
                  originIn: outbound.destinationIata,
                  arrivalIn: outbound.originIata,
                  isReturn: true
                }),
                status: 'Available'
              };
            } catch {
              return null;
            }
          })
        );

        return paired.filter(Boolean);
      };

      const requestedAirlines: SupportedAirline[] =
        normalizedAirlineCode === 'ALL'
          ? ['RYANAIR', 'WIZZ']
          : [normalizedAirlineCode as SupportedAirline];
      const anyOriginMode = originCandidates.length > 1;

      let deals: any[] = [];
      const fetchErrors: string[] = [];

      for (const originIata of originCandidates) {
        for (const airlineCodeForTask of requestedAirlines) {
          try {
            const partial = await fetchDealsForAirline(airlineCodeForTask, originIata);
            deals = deals.concat(partial);
          } catch (error: any) {
            const label = airlineCodeForTask === 'RYANAIR' ? 'Ryanair' : 'Wizz Air';
            const reason = error instanceof Error ? error.message : String(error ?? 'Erro desconhecido');
            fetchErrors.push(`${label} (${originIata}): ${reason}`);
          }
        }
      }

      deals = deals
        .filter((deal: any, index: number, arr: any[]) => {
          const key = `${deal.airline}-${deal.tripType}-${deal.originIata}-${deal.destinationIata}-${deal.departureDate}-${deal.returnDate || ''}`;
          return arr.findIndex((item: any) => `${item.airline}-${item.tripType}-${item.originIata}-${item.destinationIata}-${item.departureDate}-${item.returnDate || ''}` === key) === index;
        })
        .sort((a: any, b: any) => a.price - b.price);

      if (deals.length === 0) {
        if (fetchErrors.length > 0) {
          return res.json({
            deals: [],
            message: `${anyOriginMode ? `Sem filtro de origem ativo (${originCandidates.length} hubs). ` : ''}Não foi possível consultar algumas companhias agora: ${fetchErrors.join(' | ')}`
          });
        }

        return res.json({
          deals: [],
          message: isRoundTrip
            ? 'Não encontrei ida e volta para esse filtro. Tenta outro aeroporto, datas diferentes ou preço máximo maior.'
            : 'Não encontrei voos para esse filtro. Tenta outro aeroporto, data ou preço máximo maior.'
        });
      }

      const enrichedDeals = await enrichDealsWithLocation(deals);
      if (fetchErrors.length > 0) {
        return res.json({
          deals: enrichedDeals,
          message: `${anyOriginMode ? `Sem filtro de origem ativo (${originCandidates.length} hubs). ` : ''}Alguns resultados podem estar incompletos: ${fetchErrors.join(' | ')}`
        });
      }

      if (anyOriginMode) {
        return res.json({
          deals: enrichedDeals,
          message: `Sem filtro de origem ativo: mostrando os voos mais baratos entre ${originCandidates.length} hubs.`
        });
      }

      res.json({ deals: enrichedDeals });
    } catch (error: any) {
      console.error('Error fetching flight deals:', error.message);
      if (error.response) {
        console.error('API Response Error:', error.response.status, error.response.data);
      }
      res.status(500).json({ error: 'Failed to fetch flight data', details: error.message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
