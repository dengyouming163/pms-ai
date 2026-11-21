'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

declare global {
  interface Window {
    qq: any;
    initMapPicker: () => void;
  }
}

interface MapPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialLat?: string;
  initialLng?: string;
  initialAddress?: string;
  onConfirm: (data: { lat: string; lng: string; address: string }) => void;
}

const TENCENT_KEY = 'FWEBZ-WHSHV-IRFPO-UNMRL-5EUWV-BFBFW';

export function MapPicker({ open, onOpenChange, initialLat, initialLng, initialAddress, onConfirm }: MapPickerProps) {
  const [address, setAddress] = useState(initialAddress || '');
  const [lat, setLat] = useState(initialLat || '');
  const [lng, setLng] = useState(initialLng || '');
  const [searchText, setSearchText] = useState('');
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const geocoderRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load Tencent Maps script
  useEffect(() => {
    if (open && !scriptLoaded && !window.qq) {
      const script = document.createElement('script');
      script.src = `https://map.qq.com/api/js?v=2.exp&key=${TENCENT_KEY}&callback=initMapPicker`;
      script.async = true;
      window.initMapPicker = () => setScriptLoaded(true);
      document.head.appendChild(script);
      return () => {
        document.head.removeChild(script);
        (window as any).initMapPicker = undefined;
      };
    }
    if (open && window.qq && !scriptLoaded) {
      setScriptLoaded(true);
    }
  }, [open, scriptLoaded]);

  // Initialize map
  useEffect(() => {
    if (!scriptLoaded || !containerRef.current || !open) return;

    const centerLat = parseFloat(lat) || 26.58;  // 贵州默认中心
    const centerLng = parseFloat(lng) || 106.71;

    const map = new window.qq.maps.Map(containerRef.current, {
      center: new window.qq.maps.LatLng(centerLat, centerLng),
      zoom: 15,
    });
    mapRef.current = map;
    geocoderRef.current = new window.qq.maps.Geocoder();

    // Place existing marker if has coords
    if (lat && lng) {
      const pos = new window.qq.maps.LatLng(parseFloat(lat), parseFloat(lng));
      markerRef.current = new window.qq.maps.Marker({ position: pos, map });
      map.setCenter(pos);
    }

    // Click to pick
    window.qq.maps.event.addListener(map, 'click', (e: any) => {
      const pos = e.latLng;
      setLat(pos.getLat().toFixed(6));
      setLng(pos.getLng().toFixed(6));
      placeMarker(pos);
      reverseGeocode(pos);
    });

    return () => { mapRef.current = null; markerRef.current = null; };
  }, [scriptLoaded, open]);

  const placeMarker = (pos: any) => {
    if (markerRef.current) markerRef.current.setMap(null);
    markerRef.current = new window.qq.maps.Marker({ position: pos, map: mapRef.current });
  };

  const reverseGeocode = (pos: any) => {
    if (!geocoderRef.current) return;
    geocoderRef.current.setComplete((result: any) => {
      const addr = result.detail?.address || (result.detail?.addressComponents
        ? `${result.detail.addressComponents.province || ''}${result.detail.addressComponents.city || ''}${result.detail.addressComponents.district || ''}${result.detail.addressComponents.street || ''}${result.detail.addressComponents.streetNumber || ''}`
        : '');
      setAddress(addr);
    });
    geocoderRef.current.getAddress(pos);
  };

  const handleSearch = useCallback(async () => {
    if (!searchText || !window.qq || !mapRef.current) return;
    try {
      const res = await fetch(`/api/settings/map-search?keyword=${encodeURIComponent(searchText)}`);
      const json = await res.json();
      if (json.status === 0 && json.data?.length > 0) {
        const poi = json.data[0];
        const pos = new window.qq.maps.LatLng(poi.location.lat, poi.location.lng);
        setLat(poi.location.lat.toFixed(6));
        setLng(poi.location.lng.toFixed(6));
        setAddress(poi.title + (poi.address ? ' ' + poi.address : ''));
        placeMarker(pos);
        mapRef.current?.setCenter(pos);
        mapRef.current?.setZoom(16);
      }
    } catch (e) {
      console.log('[map] search error:', e);
    }
  }, [searchText]);

  const handleConfirm = () => {
    onConfirm({ lat, lng, address: address || searchText });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!w-[70vw] !max-w-[70vw] h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>🗺️ 门店位置</DialogTitle>
        </DialogHeader>

        {/* Search bar */}
        <div className="flex gap-2 flex-shrink-0 mb-3">
          <Input
            placeholder="搜索地址..."
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            className="flex-1"
          />
          <Button onClick={handleSearch} variant="outline">搜索</Button>
        </div>

        {/* Map */}
        <div ref={containerRef} className="flex-1 rounded-xl border border-slate-200 min-h-[300px]" />

        {/* Info */}
        <div className="flex-shrink-0 mt-3 space-y-2">
          <div className="flex gap-4 text-sm">
            <span className="text-slate-500">地址：</span>
            <span className="text-slate-700 flex-1">{address || '点击地图选取位置'}</span>
          </div>
          <div className="flex gap-4 text-sm">
            <span className="text-slate-500">坐标：</span>
            <span className="text-slate-700">{lat || '-'}, {lng || '-'}</span>
          </div>
        </div>

        <DialogFooter className="flex-shrink-0 mt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleConfirm}>确认位置</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
