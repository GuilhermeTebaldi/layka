import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Plane,
  Search,
  RefreshCw,
  Filter,
  Backpack,
  AlertCircle,
  Globe,
  Info,
  LocateFixed,
  CalendarDays,
  ArrowRightLeft,
  MapPin,
} from 'lucide-react';
import { FlightCard } from './components/FlightCard';
import { FlightDeal } from './types';

type TripType = 'ONE_WAY' | 'ROUND_TRIP';
type AirlineFilter = 'ALL' | 'RYANAIR' | 'WIZZ';
type LocationMode = 'manual' | 'auto';

type NearbyAirport = {
  iata: string;
  city: string;
  country: string;
  distanceKm: number;
};

type AirportSuggestion = {
  iata: string;
  city: string;
  country: string;
  outboundCount: number;
  label: string;
  latitude?: number;
  longitude?: number;
};

type DealSearchOverrides = {
  origin?: string;
  maxPrice?: number;
  adults?: number;
  airline?: AirlineFilter;
  tripType?: TripType;
  departureDate?: string;
  returnDate?: string;
};

type PersistedFilters = {
  selectedHub: string;
  originInput: string;
  maxPrice: number;
  adults: number;
  airline: AirlineFilter;
  tripType: TripType;
  departureDate: string;
  returnDate: string;
};

const FILTERS_STORAGE_KEY = 'layka_filters_v1';
const normalizeApiBase = (value: string) => {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.replace(/\/api$/i, '');
};

const API_BASE_URL = normalizeApiBase(String(import.meta.env.VITE_API_BASE_URL || ''));

const buildApiUrl = (path: string) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
};

const isIataCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z]{3}$/.test(value.trim().toUpperCase());

const isDateOnly = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());

const parseApiJson = async (response: Response) => {
  const raw = await response.text();
  let parsed: any = null;

  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const details = parsed?.details || parsed?.error || raw || `HTTP ${response.status}`;
    throw new Error(String(details));
  }

  if (!parsed) {
    throw new Error(
      'API respondeu em formato inválido. Verifica se o backend /api está publicado (não apenas o frontend).'
    );
  }

  return parsed;
};

const POPULAR_HUBS = [
  { iata: 'STN', name: 'London Stansted', city: 'London', country: 'UK' },
  { iata: 'LIS', name: 'Lisbon Humberto Delgado', city: 'Lisbon', country: 'Portugal' },
  { iata: 'OPO', name: 'Porto Francisco Sá Carneiro', city: 'Porto', country: 'Portugal' },
  { iata: 'MAD', name: 'Madrid Barajas', city: 'Madrid', country: 'Spain' },
  { iata: 'BCN', name: 'Barcelona El Prat', city: 'Barcelona', country: 'Spain' },
  { iata: 'DUB', name: 'Dublin Airport', city: 'Dublin', country: 'Ireland' },
  { iata: 'BGY', name: 'Milan Bergamo', city: 'Milan', country: 'Italy' },
  { iata: 'BVA', name: 'Paris Beauvais', city: 'Paris', country: 'France' },
];

const getDateOffset = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const formatHubLabel = (iata: string, nearbyAirports: NearbyAirport[]) => {
  if (iata === 'ANY') {
    return 'Sem filtro de origem (mais baratos em vários hubs)';
  }

  const fromPopular = POPULAR_HUBS.find((hub) => hub.iata === iata);
  if (fromPopular) return `${fromPopular.name} (${fromPopular.iata})`;

  const fromNearby = nearbyAirports.find((airport) => airport.iata === iata);
  if (fromNearby) return `${fromNearby.city}, ${fromNearby.country} (${fromNearby.iata})`;

  return `${iata} (IATA)`;
};

export default function App() {
  const [deals, setDeals] = useState<FlightDeal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [filtersSavedMsg, setFiltersSavedMsg] = useState<string | null>(null);
  const [filtersHydrated, setFiltersHydrated] = useState(false);
  const [selectedHub, setSelectedHub] = useState('ANY');
  const [originInput, setOriginInput] = useState('ANY');
  const [maxPrice, setMaxPrice] = useState(300);
  const [adults, setAdults] = useState(2);
  const [airline, setAirline] = useState<AirlineFilter>('ALL');
  const [tripType, setTripType] = useState<TripType>('ONE_WAY');
  const [departureDate, setDepartureDate] = useState(getDateOffset(1));
  const [returnDate, setReturnDate] = useState(getDateOffset(8));
  const [serverMsg, setServerMsg] = useState<string | null>(null);
  const [nearbyAirports, setNearbyAirports] = useState<NearbyAirport[]>([]);
  const [airportSuggestions, setAirportSuggestions] = useState<AirportSuggestion[]>([]);
  const [airportSearchLoading, setAirportSearchLoading] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoMessage, setGeoMessage] = useState<string | null>(null);
  const [locationSearchNonce, setLocationSearchNonce] = useState(0);
  const [originFromLocation, setOriginFromLocation] = useState(false);
  const autoLocateTriedRef = useRef(false);

  const originLabel = useMemo(
    () => formatHubLabel(selectedHub, nearbyAirports),
    [selectedHub, nearbyAirports]
  );

  const airlineLabel = airline === 'ALL'
    ? 'Todas (Ryanair + Wizz Air)'
    : airline === 'RYANAIR'
      ? 'Ryanair'
      : 'Wizz Air';

  const closeMobileFiltersAfterAction = () => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setMobileFiltersOpen(false);
    }
  };

  const setNoOriginFilter = (closePanel = true) => {
    setSelectedHub('ANY');
    setOriginInput('ANY');
    setOriginFromLocation(false);
    setError(null);
    setAirportSuggestions([]);
    setGeoMessage('Sem filtro de origem ativo: mostrando os voos mais baratos para qualquer destino.');
    setLocationSearchNonce((value) => value + 1);

    if (closePanel) {
      closeMobileFiltersAfterAction();
    }
  };

  const saveFiltersNow = (showFeedback = false) => {
    if (typeof window === 'undefined') return;

    const payload: PersistedFilters = {
      selectedHub,
      originInput,
      maxPrice,
      adults,
      airline,
      tripType,
      departureDate,
      returnDate
    };

    try {
      window.localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(payload));
      if (showFeedback) setFiltersSavedMsg('Filtros salvos com sucesso.');
    } catch {
      if (showFeedback) setFiltersSavedMsg('Não foi possível salvar os filtros agora.');
    }
  };

  const applyOriginFromSearch = (airport: Pick<AirportSuggestion, 'iata' | 'city' | 'country'>) => {
    const iata = airport.iata.toUpperCase();
    setSelectedHub(iata);
    setOriginInput(`${airport.city}, ${airport.country} (${iata})`);
    setGeoMessage(null);
    setOriginFromLocation(false);
    setError(null);
    setAirportSuggestions([]);
    setLocationSearchNonce((value) => value + 1);
    closeMobileFiltersAfterAction();
  };

  const applyManualOrigin = () => {
    const text = originInput.trim();
    const normalizedText = text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (
      normalizedText === 'any'
      || normalizedText.includes('sem filtro')
      || normalizedText.includes('qualquer')
      || normalizedText.includes('todos')
    ) {
      setNoOriginFilter();
      return;
    }

    const iataMatch = text.toUpperCase().match(/\b[A-Z]{3}\b/);

    if (iataMatch) {
      const iata = iataMatch[0];

      if (iata === 'ANY') {
        setNoOriginFilter();
        return;
      }

      setSelectedHub(iata);
      setOriginInput(iata);
      setGeoMessage(null);
      setOriginFromLocation(false);
      setError(null);
      setAirportSuggestions([]);
      setLocationSearchNonce((value) => value + 1);
      closeMobileFiltersAfterAction();
      return;
    }

    if (airportSuggestions.length > 0) {
      applyOriginFromSearch(airportSuggestions[0]);
      return;
    }

    setError('Digite IATA (3 letras) ou pesquise por cidade/país e escolha uma sugestão.');
  };

  const fetchDeals = async (overrides: DealSearchOverrides = {}) => {
    const nextOrigin = overrides.origin ?? selectedHub;
    const nextMaxPrice = overrides.maxPrice ?? maxPrice;
    const nextAdults = overrides.adults ?? adults;
    const nextAirline = overrides.airline ?? airline;
    const nextTripType = overrides.tripType ?? tripType;
    const nextDepartureDate = overrides.departureDate ?? departureDate;
    const nextReturnDate = overrides.returnDate ?? returnDate;

    if (nextTripType === 'ROUND_TRIP' && nextReturnDate < nextDepartureDate) {
      setDeals([]);
      setError('A data de volta deve ser igual ou maior que a data de ida.');
      return;
    }

    setLoading(true);
    setError(null);
    setServerMsg(null);

    try {
      const query = new URLSearchParams({
        origin: nextOrigin,
        adults: String(nextAdults),
        airline: nextAirline,
        tripType: nextTripType,
        departureDate: nextDepartureDate,
      });

      if (nextMaxPrice > 0) {
        query.set('maxPrice', String(nextMaxPrice));
      }

      if (nextTripType === 'ROUND_TRIP') {
        query.set('returnDate', nextReturnDate);
      }

      const response = await fetch(buildApiUrl(`/api/deals?${query.toString()}`));
      const data = await parseApiJson(response);
      if (data.error) throw new Error(data.details || 'Failed to fetch deals');
      setServerMsg(data.message || null);
      setDeals(data.deals || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const applyLocationOrigin = (airport: NearbyAirport, mode: LocationMode = 'manual') => {
    const iata = airport.iata.toUpperCase();
    setSelectedHub(iata);
    setOriginInput(iata);
    setOriginFromLocation(true);
    setError(null);
    setAirportSuggestions([]);
    setGeoMessage(
      mode === 'auto'
        ? `Origem detectada automaticamente: ${airport.city} (${iata}).`
        : `Origem definida: ${airport.city} (${iata}).`
    );
    setLocationSearchNonce((value) => value + 1);
    closeMobileFiltersAfterAction();
  };

  const useMyLocation = async (mode: LocationMode = 'manual') => {
    setGeoLoading(true);
    if (mode === 'manual') {
      setGeoMessage(null);
    }

    if (!navigator.geolocation) {
      setGeoLoading(false);
      if (mode === 'manual') {
        setGeoMessage('Geolocalização não suportada neste browser.');
      }
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const { latitude, longitude } = position.coords;
          const response = await fetch(
            buildApiUrl(`/api/airports/nearby?lat=${latitude}&lon=${longitude}&limit=8`)
          );
          const data = await parseApiJson(response);
          const airports = Array.isArray(data.airports) ? data.airports : [];
          setNearbyAirports(airports);

          if (airports.length > 0) {
            applyLocationOrigin(airports[0], mode);
          } else {
            if (mode === 'manual') {
              setGeoMessage('Não consegui encontrar aeroportos próximos para esta localização.');
            }
          }
        } catch {
          if (mode === 'manual') {
            setGeoMessage('Não foi possível carregar aeroportos próximos agora.');
          }
        } finally {
          setGeoLoading(false);
        }
      },
      () => {
        setGeoLoading(false);
        if (mode === 'manual') {
          setGeoMessage('Permissão de localização negada.');
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000,
      }
    );
  };

  useEffect(() => {
    if (typeof window === 'undefined') {
      setFiltersHydrated(true);
      return;
    }

    try {
      const raw = window.localStorage.getItem(FILTERS_STORAGE_KEY);
      if (!raw) {
        setFiltersHydrated(true);
        return;
      }

      const saved = JSON.parse(raw) as Partial<PersistedFilters>;

      if (isIataCode(saved.selectedHub)) {
        const normalizedHub = saved.selectedHub.toUpperCase();
        setSelectedHub(normalizedHub);
        setOriginInput(normalizedHub);
      }

      if (typeof saved.originInput === 'string' && saved.originInput.trim()) {
        setOriginInput(saved.originInput.trim());
      }

      if (typeof saved.maxPrice === 'number' && Number.isFinite(saved.maxPrice)) {
        const normalizedPrice = Math.min(300, Math.max(0, Math.round(saved.maxPrice / 5) * 5));
        setMaxPrice(normalizedPrice);
      }

      if (typeof saved.adults === 'number' && Number.isFinite(saved.adults)) {
        setAdults(Math.min(10, Math.max(1, Math.round(saved.adults))));
      }

      if (saved.airline === 'ALL' || saved.airline === 'RYANAIR' || saved.airline === 'WIZZ') {
        setAirline(saved.airline);
      }

      if (saved.tripType === 'ONE_WAY' || saved.tripType === 'ROUND_TRIP') {
        setTripType(saved.tripType);
      }

      if (isDateOnly(saved.departureDate)) {
        setDepartureDate(saved.departureDate);
      }

      if (isDateOnly(saved.returnDate)) {
        setReturnDate(saved.returnDate);
      }
    } catch {
      // no-op: if localStorage is invalid, fallback to defaults
    } finally {
      setFiltersHydrated(true);
    }
  }, []);

  useEffect(() => {
    const query = originInput.trim();
    const normalizedQuery = query
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (
      normalizedQuery === 'any'
      || normalizedQuery.includes('sem filtro')
      || normalizedQuery.includes('qualquer')
      || normalizedQuery.includes('todos')
    ) {
      setAirportSuggestions([]);
      setAirportSearchLoading(false);
      return;
    }

    if (query.length < 2) {
      setAirportSuggestions([]);
      setAirportSearchLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        setAirportSearchLoading(true);
        const response = await fetch(buildApiUrl(`/api/airports/search?q=${encodeURIComponent(query)}&limit=8`), {
          signal: controller.signal
        });
        const data = await parseApiJson(response);
        if (!controller.signal.aborted) {
          setAirportSuggestions(Array.isArray(data.airports) ? data.airports : []);
        }
      } catch (err: any) {
        if (!controller.signal.aborted && err?.name !== 'AbortError') {
          setAirportSuggestions([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setAirportSearchLoading(false);
        }
      }
    }, 250);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [originInput]);

  useEffect(() => {
    if (!filtersHydrated) return;
    saveFiltersNow(false);
  }, [filtersHydrated, selectedHub, originInput, maxPrice, adults, airline, tripType, departureDate, returnDate]);

  useEffect(() => {
    if (!filtersSavedMsg) return;
    const timer = window.setTimeout(() => setFiltersSavedMsg(null), 2200);
    return () => window.clearTimeout(timer);
  }, [filtersSavedMsg]);

  useEffect(() => {
    if (!filtersHydrated || autoLocateTriedRef.current) return;
    autoLocateTriedRef.current = true;
    useMyLocation('auto');
  }, [filtersHydrated]);

  useEffect(() => {
    if (!filtersHydrated) return;
    fetchDeals();
  }, [filtersHydrated, selectedHub, maxPrice, adults, airline, tripType, departureDate, returnDate, locationSearchNonce]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="min-h-screen xl:h-screen xl:overflow-hidden bg-bg-base flex flex-col font-sans">
      <header className="bg-ryanair-blue text-white min-h-20.5 px-4 md:px-8 xl:px-12 py-3 flex items-center justify-between border-b-4 border-ryanair-yellow">
        <div className="logo-area">
          <h1 className="text-[20px] md:text-[24px] font-extrabold tracking-tight flex items-center gap-2.5">
            LAYKA <span className="font-light opacity-80 hidden sm:inline">| Filtre low-cost</span>
          </h1>
        </div>

        <div className="hidden md:flex items-center gap-3 bg-white/10 px-3 py-1.5 rounded-sm text-[12px] font-semibold uppercase">
          <div className="w-2 h-2 bg-ryanair-yellow rounded-full animate-pulse shadow-[0_0_8px_rgba(241,196,15,0.5)]"></div>
          {now.toLocaleString('pt-PT')}
        </div>
      </header>

      <div className="md:hidden sticky top-0 z-30 bg-ryanair-blue text-white border-b border-ryanair-yellow/40 px-3 py-2 shadow-sm">
        <div className="rounded-lg border border-white/20 bg-white/10 p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[12px] font-extrabold tracking-wide">Painel Mobile</div>
              <div className="text-[10px] font-medium truncate opacity-90">{now.toLocaleString('pt-PT')}</div>
            </div>
            <button
              onClick={() => fetchDeals()}
              disabled={loading}
              className="text-[10px] font-bold uppercase px-2.5 py-1 rounded-md bg-white/15 border border-white/25 disabled:opacity-60"
            >
              {loading ? 'Atualizando...' : 'Atualizar'}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <div className="rounded-lg border border-white/20 bg-white/10 px-2 py-1.5">
              <div className="text-[9px] uppercase opacity-80">Origem</div>
              <div className="text-[11px] font-bold">{selectedHub === 'ANY' ? 'Sem filtro' : selectedHub}</div>
            </div>
            <div className="rounded-lg border border-white/20 bg-white/10 px-2 py-1.5">
              <div className="text-[9px] uppercase opacity-80">Companhia</div>
              <div className="text-[11px] font-bold truncate">{airline === 'ALL' ? 'Todas' : airline === 'RYANAIR' ? 'Ryanair' : 'Wizz Air'}</div>
            </div>
            <div className="rounded-lg border border-white/20 bg-white/10 px-2 py-1.5">
              <div className="text-[9px] uppercase opacity-80">Viagem</div>
              <div className="text-[11px] font-bold">{tripType === 'ROUND_TRIP' ? 'Ida e Volta' : 'Só Ida'}</div>
            </div>
            <div className="rounded-lg border border-white/20 bg-white/10 px-2 py-1.5">
              <div className="text-[9px] uppercase opacity-80">Preço Máx</div>
              <div className="text-[11px] font-bold">{maxPrice > 0 ? `€${maxPrice}` : 'Sem limite'}</div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            <button
              onClick={() => setMobileFiltersOpen((open) => !open)}
              className="inline-flex items-center justify-center gap-1 text-[10px] font-bold uppercase px-2 py-1.5 rounded-md bg-white text-ryanair-blue border border-white"
            >
              <Filter size={12} />
              Filtros
            </button>
            <button
              onClick={() => useMyLocation()}
              disabled={geoLoading}
              className="inline-flex items-center justify-center gap-1 text-[10px] font-bold uppercase px-2 py-1.5 rounded-md bg-white/15 border border-white/25 disabled:opacity-60"
            >
              <LocateFixed size={12} />
              Local
            </button>
            <button
              onClick={() => saveFiltersNow(true)}
              className="inline-flex items-center justify-center gap-1 text-[10px] font-bold uppercase px-2 py-1.5 rounded-md bg-white/15 border border-white/25"
            >
              Salvar
            </button>
          </div>

          <div className="text-[10px] font-semibold opacity-90">Resultados encontrados: {deals.length}</div>
        </div>
      </div>

      <main className="flex-1 min-h-0 w-full max-w-none px-3 sm:px-4 md:px-8 xl:px-12 py-4 md:py-6 flex flex-col xl:flex-row gap-4 md:gap-6 xl:overflow-hidden">
        <aside
          className={`${mobileFiltersOpen ? 'fixed inset-0 z-50 flex bg-black/45 p-2' : 'hidden'} md:block md:static md:inset-auto md:z-auto md:bg-transparent md:p-0 w-full xl:w-90 xl:h-full xl:overflow-y-auto xl:overscroll-contain xl:pr-1`}
          onClick={() => {
            if (mobileFiltersOpen) setMobileFiltersOpen(false);
          }}
        >
          <section
            className="bg-white p-4 md:p-5 rounded-xl border border-border-base shadow-sm w-full h-[calc(100vh-16px)] overflow-y-auto md:h-auto md:overflow-visible"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="md:hidden sticky top-0 z-10 -mx-4 px-4 pb-3 mb-4 bg-white border-b border-slate-200">
              <div className="pt-1 flex items-center justify-between gap-2">
                <h2 className="font-extrabold text-[14px] text-slate-900 uppercase tracking-wide">Filtros Mobile</h2>
                <button
                  onClick={() => setMobileFiltersOpen(false)}
                  className="px-2.5 py-1 text-[10px] font-bold uppercase border border-slate-300 rounded-md text-slate-700"
                >
                  Fechar
                </button>
              </div>
              <p className="text-[11px] text-slate-600 mt-1">
                Todos os filtros estão aqui, organizados para mobile, sem perder nenhuma função.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  onClick={() => saveFiltersNow(true)}
                  className="px-2.5 py-2 text-[10px] font-bold uppercase border border-slate-300 rounded-md text-slate-700"
                >
                  Salvar filtros
                </button>
                <button
                  onClick={() => {
                    fetchDeals();
                    setMobileFiltersOpen(false);
                  }}
                  className="px-2.5 py-2 text-[10px] font-bold uppercase rounded-md bg-ryanair-blue text-white"
                >
                  Ver resultados
                </button>
              </div>
            </div>

            <div className="hidden md:flex items-center justify-between mb-5">
              <h2 className="font-bold text-text-main flex items-center gap-2 text-[15px] uppercase tracking-wide">
                <Filter size={16} className="text-ryanair-blue" />
                Filtros
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => saveFiltersNow(true)}
                  className="px-2.5 py-1.5 text-[10px] font-bold uppercase border border-slate-300 rounded-md text-slate-700 hover:border-slate-500"
                  title="Salvar filtros"
                >
                  Salvar
                </button>
                <button
                  onClick={() => fetchDeals()}
                  disabled={loading}
                  className="text-text-muted hover:text-ryanair-blue transition-colors disabled:opacity-50"
                  title="Atualizar busca"
                >
                  <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                </button>
              </div>
            </div>

            {filtersSavedMsg && (
              <p className="text-[11px] text-emerald-700 mb-3">{filtersSavedMsg}</p>
            )}

            <div className="space-y-6 md:space-y-5">
              <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                <h3 className="text-[12px] font-bold text-slate-800 uppercase flex items-center gap-2 mb-2">
                  <Globe size={14} className="text-slate-500" />
                  Origin Hub = Aeroporto de Saída
                </h3>
                <p className="text-[11px] text-slate-600 leading-relaxed">
                  As siglas como <b>LIS</b>, <b>OPO</b> e <b>MAD</b> são códigos IATA (3 letras) dos aeroportos.
                  Você pode usar os botões rápidos, digitar qualquer IATA manualmente, ou detectar aeroportos próximos da sua localização.
                </p>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-text-muted uppercase tracking-wider mb-2">
                  Origem (cidade, país ou IATA)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={originInput}
                    onChange={(e) => {
                      setOriginInput(e.target.value);
                      setError(null);
                    }}
                    placeholder="Ex: Rome, Italy ou FCO"
                    className="flex-1 px-3 py-2 border border-border-base rounded-md text-[13px] focus:border-ryanair-blue outline-none"
                  />
                  <button
                    onClick={applyManualOrigin}
                    className="px-3 py-2 border border-ryanair-blue text-ryanair-blue rounded-md text-[11px] font-bold hover:bg-ryanair-blue hover:text-white transition-colors"
                  >
                    Buscar
                  </button>
                </div>
                <button
                  onClick={() => setNoOriginFilter()}
                  className="mt-2 w-full md:w-auto px-3 py-2 rounded-md border border-slate-300 text-slate-700 text-[11px] font-bold hover:border-slate-500"
                >
                  Sem filtro de origem (mais baratos globais)
                </button>
                {airportSearchLoading && originInput.trim().length >= 2 && (
                  <p className="text-[11px] text-slate-500 mt-1">Procurando aeroportos...</p>
                )}
                {airportSuggestions.length > 0 && originInput.trim().length >= 2 && (
                  <div className="mt-2 border border-slate-200 rounded-lg bg-white max-h-56 overflow-auto">
                    {airportSuggestions.map((airport) => (
                      <button
                        key={`${airport.iata}-${airport.city}-${airport.country}`}
                        onClick={() => applyOriginFromSearch(airport)}
                        className="w-full text-left px-3 py-2 border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
                      >
                        <div className="text-[12px] font-semibold text-slate-800">{airport.label}</div>
                        <div className="text-[11px] text-slate-600">
                          Voos de saída disponíveis: {airport.outboundCount}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-text-muted mt-1">
                  Hub atual: <b>{originLabel}</b>
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-[11px] font-bold text-text-muted uppercase tracking-wider">
                    {originFromLocation
                      ? 'Origem definida pela localização'
                      : selectedHub === 'ANY'
                        ? 'Sem filtro de origem ativo'
                        : 'Hubs Populares'}
                  </label>
                  <button
                    onClick={() => useMyLocation()}
                    disabled={geoLoading}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold border border-slate-300 text-slate-700 hover:border-slate-500 disabled:opacity-60"
                  >
                    <LocateFixed size={12} />
                    {geoLoading ? 'Localizando...' : 'Usar minha localização'}
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-2">
                  {POPULAR_HUBS.map((hub) => (
                    <button
                      key={hub.iata}
                      onClick={() => {
                        setSelectedHub(hub.iata);
                        setOriginInput(hub.iata);
                        setGeoMessage(null);
                        setOriginFromLocation(false);
                        setAirportSuggestions([]);
                        setLocationSearchNonce((value) => value + 1);
                        closeMobileFiltersAfterAction();
                      }}
                      className={`text-left px-3 py-2 rounded-md border transition-all ${
                        selectedHub === hub.iata
                          ? 'border-ryanair-blue bg-ryanair-blue/5 text-ryanair-blue'
                          : 'border-border-base text-text-muted hover:border-[#ADB5BD]'
                      }`}
                    >
                      <div className="text-[12px] font-semibold">{hub.name}</div>
                      <div className="text-[11px] font-mono opacity-80">{hub.city} ({hub.iata})</div>
                    </button>
                  ))}
                </div>

                {geoMessage && (
                  <p className="text-[11px] text-emerald-700 mt-2">{geoMessage}</p>
                )}

                {nearbyAirports.length > 0 && (
                  <div className="mt-3 p-3 rounded-lg border border-slate-200 bg-slate-50">
                    <div className="text-[11px] font-bold text-slate-700 mb-2 flex items-center gap-1">
                      <MapPin size={12} />
                      Aeroportos mais próximos (pela sua localização)
                    </div>
                    <div className="space-y-1.5">
                      {nearbyAirports.map((airport) => (
                        <button
                          key={`${airport.iata}-${airport.distanceKm}`}
                          onClick={() => applyLocationOrigin(airport)}
                          className="w-full text-left px-2.5 py-2 rounded-md border border-transparent hover:border-slate-300 bg-white"
                        >
                          <div className="text-[12px] font-semibold text-slate-800">
                            {airport.city} ({airport.iata})
                          </div>
                          <div className="text-[11px] text-slate-600">
                            {airport.country} · {airport.distanceKm.toFixed(1)} km
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-[11px] font-bold text-text-muted uppercase tracking-wider mb-2">Companhia</label>
                <div className="grid grid-cols-3 gap-0.5 bg-slate-100 p-0.5 rounded-md">
                  <button
                    onClick={() => setAirline('ALL')}
                    className={`py-2 rounded text-[10px] font-bold uppercase tracking-wider transition-all ${
                      airline === 'ALL' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    Todas
                  </button>
                  <button
                    onClick={() => setAirline('RYANAIR')}
                    className={`py-2 rounded text-[10px] font-bold uppercase tracking-wider transition-all ${
                      airline === 'RYANAIR' ? 'bg-ryanair-blue text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    Ryanair
                  </button>
                  <button
                    onClick={() => setAirline('WIZZ')}
                    className={`py-2 rounded text-[10px] font-bold uppercase tracking-wider transition-all ${
                      airline === 'WIZZ' ? 'bg-[#7E007B] text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    Wizz Air
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-text-muted uppercase tracking-wider mb-2">
                  Tipo de viagem
                </label>
                <div className="flex gap-0.5 bg-slate-100 p-0.5 rounded-md">
                  <button
                    onClick={() => setTripType('ONE_WAY')}
                    className={`flex-1 py-2 rounded text-[10px] font-bold uppercase tracking-wider transition-all ${
                      tripType === 'ONE_WAY' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    Só Ida
                  </button>
                  <button
                    onClick={() => setTripType('ROUND_TRIP')}
                    className={`flex-1 py-2 rounded text-[10px] font-bold uppercase tracking-wider transition-all ${
                      tripType === 'ROUND_TRIP' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    Ida e Volta
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3">
                <div>
                  <label className="block text-[11px] font-bold text-text-muted uppercase tracking-wider mb-2">
                    <span className="inline-flex items-center gap-1"><CalendarDays size={12} /> Data de ida</span>
                  </label>
                  <input
                    type="date"
                    value={departureDate}
                    onChange={(e) => setDepartureDate(e.target.value)}
                    className="w-full px-3 py-2 border border-border-base rounded-md text-[13px]"
                  />
                </div>

                {tripType === 'ROUND_TRIP' && (
                  <div>
                    <label className="block text-[11px] font-bold text-text-muted uppercase tracking-wider mb-2">
                      <span className="inline-flex items-center gap-1"><ArrowRightLeft size={12} /> Data de volta</span>
                    </label>
                    <input
                      type="date"
                      value={returnDate}
                      min={departureDate}
                      onChange={(e) => setReturnDate(e.target.value)}
                      className="w-full px-3 py-2 border border-border-base rounded-md text-[13px]"
                    />
                  </div>
                )}
              </div>

              <div>
                <label className="block text-[11px] font-bold text-text-muted uppercase tracking-wider mb-2">
                  Passageiros (adultos)
                </label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={adults}
                  onChange={(e) => setAdults(parseInt(e.target.value, 10) || 1)}
                  className="w-full px-3 py-2 border border-border-base rounded-md text-[13px] font-mono focus:border-ryanair-blue outline-none"
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-2">
                  <label className="block text-[11px] font-bold text-text-muted uppercase tracking-wider">Preço Máximo</label>
                  <span className="text-[14px] font-bold text-ryanair-blue font-mono">{maxPrice > 0 ? `€${maxPrice}` : 'Sem limite'}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="300"
                  step="5"
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(parseInt(e.target.value, 10))}
                  className="w-full h-1 bg-border-base rounded-lg appearance-none cursor-pointer accent-ryanair-blue"
                />
                {maxPrice === 0 && (
                  <p className="text-[11px] text-slate-600 mt-1">
                    Sem limite de preço: mostrando todos os voos disponíveis na data selecionada.
                  </p>
                )}
              </div>

              <div className="pt-4 border-t border-border-base">
                <div className="flex items-start gap-2.5 bg-[#f0f4ff] p-3.5 rounded-md border border-ryanair-blue/10">
                  <Backpack className="text-ryanair-blue shrink-0" size={16} />
                  <p className="text-[11px] text-ryanair-blue font-medium leading-relaxed">
                    <b>Filtro aplicado:</b> tarifa base com bagagem de cabine pequena.
                  </p>
                </div>
              </div>
            </div>
          </section>
        </aside>

        <section className="flex-1 min-w-0 space-y-4 md:space-y-5 xl:h-full xl:overflow-y-auto xl:overscroll-contain xl:pr-1">
          <div className="filter-summary hidden md:flex flex-wrap items-center gap-3 bg-white p-4 rounded-lg border border-border-base">
            <div className="text-[13px] text-text-muted">Companhia: <b className="text-text-main">{airlineLabel}</b></div>
            <div className="text-[13px] text-text-muted">Origem: <b className="text-text-main">{originLabel}</b></div>
            <div className="text-[13px] text-text-muted">
              Viagem: <b className="text-text-main">{tripType === 'ROUND_TRIP' ? 'Ida e Volta' : 'Só Ida'}</b>
            </div>
            <div className="text-[13px] text-text-muted ml-auto">Resultados: <b className="text-text-main">{deals.length}</b></div>
          </div>

          {serverMsg && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-indigo-50 border border-indigo-100 p-4 rounded-lg flex items-start gap-3"
            >
              <Info size={18} className="text-indigo-600 shrink-0 mt-0.5" />
              <p className="text-[12px] text-indigo-900 leading-relaxed font-medium">{serverMsg}</p>
            </motion.div>
          )}

          <AnimatePresence mode="wait">
            {loading ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center justify-center py-20 bg-white rounded-2xl border border-[#E9ECEF] border-dashed"
              >
                <div className="relative w-16 h-16 mb-4">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
                    className="absolute inset-0 border-4 border-ryanair-blue/10 border-t-ryanair-blue rounded-full"
                  />
                  <Plane className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-ryanair-blue" size={24} />
                </div>
                <h3 className="font-bold text-[#495057]">Buscando ofertas...</h3>
                <p className="text-xs text-[#868E96] mt-1 font-mono uppercase tracking-widest">
                  {tripType === 'ROUND_TRIP' ? 'Ida e volta com datas exatas' : 'Ida com data exata'}
                </p>
              </motion.div>
            ) : error ? (
              <motion.div
                key="error"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="p-8 bg-red-50 border border-red-100 rounded-2xl flex flex-col items-center text-center"
              >
                <AlertCircle className="text-red-400 mb-3" size={32} />
                <h3 className="font-bold text-red-900">Erro de comunicação</h3>
                <p className="text-sm text-red-700 mt-1 max-w-xl">{error}</p>
                <button
                  onClick={() => fetchDeals()}
                  className="mt-6 px-4 py-2 bg-red-100 text-red-700 rounded-lg text-xs font-bold hover:bg-red-200 transition-colors"
                >
                  Tentar novamente
                </button>
              </motion.div>
            ) : deals.length === 0 ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="p-12 bg-white rounded-2xl border border-[#E9ECEF] flex flex-col items-center text-center"
              >
                <Search className="text-[#ADB5BD] mb-4" size={48} />
                <h3 className="text-xl font-bold text-[#495057]">Nenhuma oferta encontrada</h3>
                <p className="text-sm text-[#868E96] mt-2 max-w-md">
                  Ajuste o preço máximo, as datas ou o aeroporto de origem. Dica: use “minha localização” para encontrar o aeroporto mais próximo.
                </p>
              </motion.div>
            ) : (
              <motion.div
                key="results"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col gap-3"
              >
                {deals.map((deal, idx) => (
                  <FlightCard
                    key={`${deal.tripType || 'ONE_WAY'}-${deal.originIata}-${deal.destinationIata}-${deal.departureDate}-${deal.returnDate || ''}`}
                    deal={deal}
                    index={idx}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </main>

      <footer className="bg-white border-t border-border-base py-4 px-4 md:px-8 xl:px-12 flex flex-col md:flex-row justify-between items-center text-[12px] color-text-muted mt-auto gap-3">
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center gap-1.5">🎒 <b>Tarifa base:</b> bagagem pequena</div>
          <div className="flex items-center gap-1.5">📍 <b>Origem:</b> por sigla IATA ou geolocalização</div>
        </div>
        <div>Atualizado em {new Date().toLocaleDateString()}</div>
      </footer>
    </div>
  );
}
