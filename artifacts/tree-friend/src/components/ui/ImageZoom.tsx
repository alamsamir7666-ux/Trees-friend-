import { useState, useRef, useCallback } from "react";

interface ImageZoomProps {
  src: string;
  alt: string;
  className?: string;
}

export function ImageZoom({ src, alt, className = "" }: ImageZoomProps) {
  const [zoomed, setZoomed] = useState(false);
  const [pos, setPos] = useState({ x: 50, y: 50 });
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setPos({ x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) });
  }, []);

  // Touch support for mobile pinch-zoom feel
  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const touch = e.touches[0];
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || !touch) return;
    const x = ((touch.clientX - rect.left) / rect.width) * 100;
    const y = ((touch.clientY - rect.top) / rect.height) * 100;
    setPos({ x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) });
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden cursor-zoom-in select-none ${className}`}
      onMouseEnter={() => setZoomed(true)}
      onMouseLeave={() => setZoomed(false)}
      onMouseMove={handleMouseMove}
      onTouchStart={() => setZoomed(true)}
      onTouchEnd={() => setZoomed(false)}
      onTouchMove={handleTouchMove}
      aria-label={`${alt} - hover to zoom`}
    >
      <img
        src={src}
        alt={alt}
        className="w-full h-full object-cover transition-transform duration-100"
        style={
          zoomed
            ? {
                transform: "scale(2.2)",
                transformOrigin: `${pos.x}% ${pos.y}%`,
                cursor: "zoom-in",
              }
            : undefined
        }
        draggable={false}
        loading="lazy"
        decoding="async"
      />
      {!zoomed && (
        <div className="absolute bottom-2 right-2 bg-background/70 backdrop-blur-sm rounded-full px-2 py-0.5 text-xs text-muted-foreground pointer-events-none">
          Hover to zoom
        </div>
      )}
    </div>
  );
}
