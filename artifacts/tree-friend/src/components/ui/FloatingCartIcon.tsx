import { useRef, useState, useEffect } from "react";
import { ShoppingBag } from "lucide-react";
import { useLocation } from "wouter";
import { useGetCart, getGetCartQueryKey } from "@workspace/api-client-react";
import { useUser } from "@clerk/react";
import { useGuestCart } from "@/hooks/useGuestCart";

const STORAGE_KEY = "treefriend_float_v1";
const ICON_SIZE_MOBILE = 56;
const ICON_SIZE_DESKTOP = 64;
const EDGE_MOBILE = 16;
const EDGE_DESKTOP = 24;

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export function FloatingCartIcon() {
  const { user } = useUser();
  const [location, navigate] = useLocation();
  const { data: cart } = useGetCart({
    query: { enabled: !!user, queryKey: getGetCartQueryKey() },
  });
  const guestCart = useGuestCart();

  // Responsive breakpoint detection for desktop-specific sizing
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    setIsDesktop(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const ICON_SIZE = isDesktop ? ICON_SIZE_DESKTOP : ICON_SIZE_MOBILE;
  const EDGE = isDesktop ? EDGE_DESKTOP : EDGE_MOBILE;

  const serverCount = cart?.items?.reduce((s, i) => s + i.quantity, 0) ?? 0;
  const count = user ? serverCount : guestCart.totalCount;

  const [pos, setPos] = useState({ x: -999, y: -999 });
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, px: 0, py: 0 });
  const hasMoved = useRef(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (s) {
        const p = JSON.parse(s);
        if (p.x > 0 && p.y > 0 && p.x < window.innerWidth && p.y < window.innerHeight) {
          setPos(p);
          return;
        }
      }
    } catch {}
    setPos({
      x: window.innerWidth - ICON_SIZE - EDGE,
      y: window.innerHeight * 0.75,
    });
  }, []);

  useEffect(() => {
    const onResize = () => {
      setPos(prev => {
        const x = clamp(prev.x, EDGE, window.innerWidth - ICON_SIZE - EDGE);
        const y = clamp(prev.y, EDGE + 64, window.innerHeight - ICON_SIZE - EDGE);
        return { x, y };
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [ICON_SIZE, EDGE]);

  if (count === 0) return null;
  // Only hide inside an ACTIVE conversation (/messages/:id) where the
  // floating icon would overlap the chat composer. On the /messages LIST
  // page (no trailing slash, no conversationId) the icon is fine to show.
  if (location.startsWith('/cart') || location.startsWith('/checkout') || location.startsWith('/orders') || location.startsWith('/messages/')) return null;

  function onPointerDown(e: React.PointerEvent) {
    isDragging.current = true;
    hasMoved.current = false;
    dragStart.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
    ref.current?.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!isDragging.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) hasMoved.current = true;
    setPos({
      x: clamp(dragStart.current.px + dx, EDGE, window.innerWidth - ICON_SIZE - EDGE),
      y: clamp(dragStart.current.py + dy, EDGE + 64, window.innerHeight - ICON_SIZE - EDGE),
    });
  }

  function onPointerUp() {
    isDragging.current = false;
    const final = {
      x: window.innerWidth < 768 ? window.innerWidth - ICON_SIZE - EDGE : pos.x,
      y: clamp(pos.y, EDGE + 64, window.innerHeight - ICON_SIZE - EDGE),
    };
    setPos(final);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(final));
    if (!hasMoved.current) navigate("/cart");
  }

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: ICON_SIZE,
        height: ICON_SIZE,
        zIndex: 9999,
        touchAction: "none",
        userSelect: "none",
        cursor: "grab",
      }}
    >
      <div className="relative w-full h-full rounded-full bg-foreground shadow-2xl flex items-center justify-center border-2 border-background/20">
        <ShoppingBag className="h-6 w-6 lg:h-7 lg:w-7 text-background" />
        <span className="absolute -top-1.5 -right-1.5 lg:-top-2 lg:-right-2 h-5 w-5 lg:h-6 lg:w-6 rounded-full bg-accent text-accent-foreground text-[10px] lg:text-xs font-bold flex items-center justify-center border-2 border-background shadow">
          {count > 99 ? "99+" : count}
        </span>
      </div>
    </div>
  );
}
