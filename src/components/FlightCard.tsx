import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  ArrowRight,
  Backpack,
  ExternalLink,
  MapPin,
  CalendarDays,
  ArrowRightLeft,
  X,
  Navigation,
} from 'lucide-react';

import { FlightDeal } from '../types';

interface FlightCardProps {
  deal: FlightDeal;
  index: number;
  key?: string | number;
}

export function FlightCard({ deal, index }: FlightCardProps) {
  const [isMapOpen, setIsMapOpen] = useState(false);

  const isWizz = deal.airline.toUpperCase() === 'WIZZ' || deal.airline.toUpperCase() === 'WIZZ AIR';
  const isRoundTrip = deal.tripType === 'ROUND_TRIP' || Boolean(deal.returnDate);

  const brandColor = isWizz ? '#7E007B' : '#073590';
  const brandBg = isWizz ? '#FCE4EC' : '#f0f4ff';

  const destinationLabel = useMemo(() => {
    const city = deal.destinationCity || deal.destination;
    const country = deal.destinationCountry;
    return [city, country].filter(Boolean).join(', ');
  }, [deal.destinationCity, deal.destinationCountry, deal.destination]);

  const previewImage = deal.destinationPhotoUrl || deal.destinationPreviewImageUrl;

  const mapEmbedUrl =
    deal.destinationMapEmbedUrl ||
    `https://www.google.com/maps?q=${encodeURIComponent(destinationLabel || deal.destinationIata)}&output=embed`;

  const mapUrl =
    deal.destinationMapUrl ||
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destinationLabel || deal.destinationIata)}`;

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: index * 0.04 }}
        className="bg-white border border-border-base rounded-[10px] overflow-hidden transition-colors group flex flex-col lg:flex-row"
      >
        <div className="flex-1 p-4 lg:p-5">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="text-[12px] font-bold font-mono px-2 py-1 rounded" style={{ backgroundColor: brandBg, color: brandColor }}>
              {isWizz ? 'WIZZ' : 'RYANAIR'}
            </div>
            <div className="text-[11px] font-bold px-2 py-1 rounded bg-slate-100 text-slate-700 uppercase tracking-wide">
              {isRoundTrip ? 'Ida e Volta' : 'Só Ida'}
            </div>
            <div className="ml-auto text-[11px] font-bold text-success-base uppercase">Disponível</div>
          </div>

          <div className="text-[16px] font-bold text-text-main flex items-center gap-2 mb-1">
            {deal.originIata} <ArrowRight size={15} className="text-text-muted" /> {deal.destinationIata}
          </div>
          <div className="text-[12px] text-text-muted mb-3">
            {deal.origin} → {deal.destination}
          </div>

          <div className="space-y-2.5 mb-4">
            <div className="flex flex-wrap items-center gap-3 text-[12px]">
              <span className="inline-flex items-center gap-1 text-slate-600 min-w-[78px]">
                <CalendarDays size={13} /> Ida
              </span>
              <span className="font-semibold text-slate-900">{deal.departureDate}</span>
              <span className="text-slate-700">{deal.departureTime} → {deal.arrivalTime}</span>
            </div>

            {isRoundTrip && deal.returnDate && (
              <div className="flex flex-wrap items-center gap-3 text-[12px]">
                <span className="inline-flex items-center gap-1 text-slate-600 min-w-[78px]">
                  <ArrowRightLeft size={13} /> Volta
                </span>
                <span className="font-semibold text-slate-900">{deal.returnDate}</span>
                <span className="text-slate-700">
                  {deal.returnTime || '--:--'} → {deal.returnArrivalTime || '--:--'}
                </span>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[4px] text-[11px] font-bold"
              style={{ backgroundColor: brandBg, color: brandColor }}
            >
              <Backpack size={13} /> {isWizz ? 'CABIN SMALL' : 'BASIC'}
            </span>

            <div className="text-[20px] font-extrabold text-text-main leading-none">
              € {deal.price}
            </div>

            {deal.outboundPrice && isRoundTrip && deal.returnPrice && (
              <div className="text-[11px] text-text-muted">
                ida €{deal.outboundPrice} + volta €{deal.returnPrice}
              </div>
            )}

            {deal.pricePerPerson && (
              <div className="text-[11px] text-text-muted font-mono">
                pp: €{deal.pricePerPerson}
              </div>
            )}

            <a
              href={deal.link}
              target="_blank"
              rel="noopener noreferrer"
              style={{ borderColor: brandColor, color: brandColor }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = brandColor;
                e.currentTarget.style.color = '#fff';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = brandColor;
              }}
              className="ml-auto px-4 py-2 border rounded-[6px] text-[12px] font-bold transition-all whitespace-nowrap"
            >
              RESERVAR
            </a>
          </div>
        </div>

        <aside className="lg:w-[310px] border-t lg:border-t-0 lg:border-l border-border-base bg-slate-50 flex flex-col">
          <button
            onClick={() => setIsMapOpen(true)}
            className="relative h-[185px] bg-slate-200 overflow-hidden"
            title="Abrir mapa"
          >
            {previewImage ? (
              <img
                src={previewImage}
                alt={`Preview de ${destinationLabel || deal.destinationIata}`}
                loading="lazy"
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center text-slate-500 text-sm font-semibold">
                Sem foto disponível
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/65 to-transparent text-white text-left">
              <div className="text-[12px] font-bold inline-flex items-center gap-1">
                <MapPin size={13} />
                {destinationLabel || deal.destinationIata}
              </div>
            </div>
          </button>

          <div className="p-3 space-y-2">
            <div className="text-[12px] text-slate-700 leading-relaxed">
              {destinationLabel || deal.destinationIata}
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setIsMapOpen(true)}
                className="flex-1 px-3 py-2 rounded-[6px] text-[11px] font-bold border border-slate-300 text-slate-700 hover:border-slate-500"
              >
                Ver mapa
              </button>

              <a
                href={mapUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-[6px] text-[11px] font-bold border border-slate-300 text-slate-700 hover:border-slate-500"
              >
                <ExternalLink size={12} /> Abrir
              </a>
            </div>
          </div>
        </aside>
      </motion.div>

      {isMapOpen && (
        <div className="fixed inset-0 z-[70] bg-black/70 p-3 md:p-6 flex items-center justify-center">
          <div className="w-full max-w-6xl h-[85vh] bg-white rounded-[10px] shadow-2xl border border-slate-200 overflow-hidden flex flex-col">
            <div className="h-[52px] px-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="text-[13px] font-bold text-slate-800 inline-flex items-center gap-2">
                <Navigation size={14} />
                {destinationLabel || `${deal.destinationIata}`}
              </div>
              <button
                onClick={() => setIsMapOpen(false)}
                className="p-1.5 rounded hover:bg-slate-200 text-slate-600"
                title="Fechar mapa"
              >
                <X size={16} />
              </button>
            </div>

            <iframe
              src={mapEmbedUrl}
              title={`Mapa ${destinationLabel || deal.destinationIata}`}
              loading="lazy"
              className="w-full flex-1"
              referrerPolicy="no-referrer-when-downgrade"
            />

            <div className="h-[48px] px-4 border-t border-slate-200 flex items-center justify-end bg-white">
              <a
                href={mapUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[12px] font-bold text-slate-700 hover:text-slate-900"
              >
                <ExternalLink size={13} /> Abrir no mapa
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
