import { Link } from "wouter";
import { apiClient } from "@/lib/apiClient";

function TrackIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function OrdersIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <path d="M16 10a4 4 0 0 1-8 0" />
    </svg>
  );
}

function WishlistIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function AccountIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

const supportLinks = [
  { label: "Track Order", href: "/track", icon: TrackIcon },
  { label: "My Orders", href: "/orders", icon: OrdersIcon },
  { label: "Wishlist", href: "/wishlist", icon: WishlistIcon },
  { label: "Account", href: "/profile", icon: AccountIcon },
];

function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
    </svg>
  );
}

function InstagramIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
    </svg>
  );
}

function TikTokIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z" />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

const socials = [
  { label: "Facebook", href: "https://www.facebook.com/profile.php?id=61583932632838", icon: FacebookIcon },
  { label: "Instagram", href: "https://www.instagram.com/envyenhance?igsh=YzhiemswcWE3a3li", icon: InstagramIcon },
  { label: "TikTok", href: "https://www.tiktok.com/@envyenhance", icon: TikTokIcon },
  { label: "WhatsApp", href: "https://wa.me/01636575741", icon: WhatsAppIcon },
];

function SectionTitle({ iconSrc, children }: { iconSrc: string; children: React.ReactNode }) {
  return (
    <h2 className="tf-section-title">
      <img src={iconSrc} alt="" className="tf-title-icon" />
      <span className="tf-title-text">{children}</span>
      <span className="tf-title-line" />
      <img
        src="https://res.cloudinary.com/dcfbtdp6r/image/upload/v1783777695/f5466fe3-bd88-43ad-a8be-389ad10465e3_11zon-removebg-preview_11zon_nmqk0e.png"
        alt=""
        className="tf-title-leaf"
      />
    </h2>
  );
}

export function Footer() {
  return (
    <footer className="tf-footer">
      <style>{`
        .tf-footer {
          --tf-bg: hsl(var(--background));
          --tf-heading: hsl(var(--primary));
          --tf-text: hsl(var(--foreground));
          --tf-accent: hsl(var(--primary));
          --tf-border: hsl(var(--border));
          --tf-input-bg: hsl(var(--card));
          --tf-font-serif: 'Lora', serif;
          --tf-font-sans: 'Jost', sans-serif;

          position: relative;
          overflow: hidden;
          background-color: var(--tf-bg);
          font-family: var(--tf-font-sans);
          color: var(--tf-text);
          line-height: 1.65;
          padding: 30px 20px 0 20px;
        }

        .tf-inner {
          max-width: 460px;
          width: 100%;
          position: relative;
          margin: 0 auto;
        }

        .tf-brand-header {
          display: flex;
          align-items: center;
          gap: 14px;
          margin-bottom: 16px;
          position: relative;
          z-index: 1;
        }

        .tf-brand-logo {
          width: 85px;
          height: auto;
          object-fit: contain;
          flex-shrink: 0;
        }

        .tf-brand-title {
          font-family: var(--tf-font-serif);
          font-size: 2.15rem;
          color: green;
          margin-left: -10px;
          font-weight: 700;
          letter-spacing: -0.5px;
          line-height: 1.1;
          display: inline-block;
        }

        .tf-section-title {
          font-family: var(--tf-font-serif);
          color: var(--tf-accent);
          font-weight: 700;
          font-size: 1.1rem;
          display: flex;
          align-items: center;
          margin: 24px 0 14px 0;
          white-space: nowrap;
          position: relative;
          z-index: 1;
        }

        .tf-title-icon {
          width: 25px;
          height: 25px;
          object-fit: contain;
          flex-shrink: 0;
          margin-right: 10px;
        }

        .tf-title-text {
          margin-right: 12px;
          color: green;
        }

        .tf-title-line {
          flex: 1;
          height: 1px;
          background-color: var(--tf-border);
          min-width: 20px;
          margin: 0;
        }

        .tf-title-leaf {
          width: 50px;
          height: auto;
          object-fit: contain;
          flex-shrink: 0;
          opacity: 0.9;
          margin-left: -4px;
        }

        .tf-text-block {
          max-width: 285px;
          width: 100%;
          position: relative;
          z-index: 1;
        }

        .tf-text-block p {
          font-size: 0.81rem;
          color: var(--tf-text);
          margin-bottom: 12px;
          font-weight: 400;
        }

        .tf-tagline {
          color: var(--tf-accent);
          font-weight: 500;
          font-size: 0.84rem;
          margin-top: 14px;
          margin-bottom: 0;
        }

        .tf-support-list {
          list-style: none;
          position: relative;
          z-index: 1;
          margin: 0;
          padding: 0;
        }

        .tf-support-list li {
          border-bottom: 1px solid var(--tf-border);
        }

        .tf-support-list li:last-child {
          border-bottom: none;
        }

        .tf-support-list a {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 12px 0;
          text-decoration: none;
          color: var(--tf-text);
          font-size: 0.84rem;
          transition: color 0.2s ease, transform 0.2s ease;
        }

        .tf-support-list a:hover {
          color: var(--tf-accent);
          transform: translateX(4px);
        }

        .tf-support-list svg {
          width: 18px;
          height: 18px;
          stroke: var(--tf-heading);
          stroke-width: 1.6;
          fill: none;
          flex-shrink: 0;
        }

        .tf-newsletter-form {
          display: flex;
          gap: 10px;
          margin-top: 14px;
          width: 100%;
          position: relative;
          z-index: 1;
        }

        .tf-newsletter-input {
          flex: 1;
          padding: 10px 14px;
          border: 1px solid var(--tf-border);
          border-radius: 8px;
          background-color: var(--tf-input-bg);
          font-family: var(--tf-font-sans);
          font-size: 0.81rem;
          color: var(--tf-text);
          outline: none;
          transition: border-color 0.2s;
        }

        .tf-newsletter-input::placeholder {
          color: #888888;
        }

        .tf-newsletter-input:focus {
          border-color: var(--tf-accent);
        }

        .tf-btn-join {
          background-color: var(--tf-accent);
          color: #ffffff;
          border: none;
          border-radius: 8px;
          padding: 0 22px;
          font-family: var(--tf-font-sans);
          font-size: 0.81rem;
          font-weight: 500;
          cursor: pointer;
          transition: background-color 0.2s, transform 0.1s;
        }

        .tf-btn-join:hover {
          background-color: color-mix(in srgb, hsl(var(--primary)) 85%, black);
        }

        .tf-btn-join:active {
          transform: scale(0.98);
        }

        .tf-landscape-wrapper {
          position: relative;
          width: calc(100% + 40px);
          margin-left: -20px;
          margin-right: -20px;
          margin-top: -135px;
        }

        .tf-social-links {
          display: flex;
          justify-content: start;
          gap: 12px;
          position: absolute;
          bottom: 30%;
          left: 20px;
          z-index: 2;
          width: 100%;
        }

        .tf-social-btn {
          width: 42px;
          height: 42px;
          border-radius: 50%;
          border: 1px solid var(--tf-accent);
          background-color: transparent;
          display: flex;
          align-items: center;
          justify-content: center;
          text-decoration: none;
          color: var(--tf-heading);
          transition: background-color 0.2s, border-color 0.2s, color 0.2s, transform 0.2s;
        }

        .tf-social-btn:hover {
          background-color: hsl(var(--secondary));
          border-color: hsl(var(--accent-text));
          transform: translateY(-2px);
        }

        .tf-social-btn svg {
          width: 18px;
          height: 18px;
        }

        .tf-trees {
          width: 100%;
          height: auto;
          display: block;
          pointer-events: none;
          position: relative;
          z-index: 1;
        }

        .tf-bottom {
          text-align: center;
          font-size: 0.75rem;
          color: #ffffff;
          background-color: var(--tf-accent);
          padding: 15px 0;
          width: calc(100% + 40px);
          margin-left: -20px;
          margin-right: -20px;
          position: relative;
          z-index: 2;
        }
      `}</style>

      <div className="tf-inner">
        {/* Brand */}
        <div className="tf-brand-header">
          <img
            src="https://res.cloudinary.com/dcfbtdp6r/image/upload/v1784019532/IMG_20260710_151144-removebg-preview_11zon_ck95ax_rfpcoi.png"
            alt="Tree Friend Logo"
            className="tf-brand-logo"
          />
          <span className="tf-brand-title">Tree Friend</span>
        </div>

        <div className="tf-text-block">
          <p>
            Tree Friend brings you a wide variety of premium trees and plants to green your space and enrich your life. From fruit trees to ornamental plants, we ensure healthy quality, expert care, and a seamless shopping experience &ndash; helping you grow a greener tomorrow.
          </p>
          <p className="tf-tagline">Grow with nature. Live with purpose.</p>
        </div>

        {/* Support */}
        <SectionTitle iconSrc="https://res.cloudinary.com/dcfbtdp6r/image/upload/v1784018711/IMG_20260714_144403-removebg-preview_irav6y.png">
          Support
        </SectionTitle>
        <ul className="tf-support-list">
          {supportLinks.map(({ label, href, icon: Icon }) => (
            <li key={label}>
              <Link href={href}>
                <Icon />
                {label}
              </Link>
            </li>
          ))}
        </ul>

        {/* Newsletter */}
        <SectionTitle iconSrc="https://res.cloudinary.com/dcfbtdp6r/image/upload/v1783925868/IMG_20260713_125618-removebg-preview_vjieyy.png">
          Stay Updated
        </SectionTitle>
        <div className="tf-text-block">
          <p>Subscribe for exclusive deals and new arrivals.</p>
        </div>
        <form
          className="tf-newsletter-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const input = form.elements.namedItem("email") as HTMLInputElement;
            if (!input?.value || !input.checkValidity()) return;
            const email = input.value.trim();
            try {
              await apiClient.post("/api/newsletter/subscribe", { email });
              input.value = "";
              alert("Thank you for subscribing! 🌱");
            } catch {}
          }}
        >
          <input
            type="email"
            name="email"
            placeholder="Your email address"
            required
            className="tf-newsletter-input"
            aria-label="Email address for newsletter"
          />
          <button type="submit" className="tf-btn-join">Join</button>
        </form>

        {/* Connect With Us */}
        <SectionTitle iconSrc="https://res.cloudinary.com/dcfbtdp6r/image/upload/v1783928352/Adobe_Express_-_file_p8qzoy.png">
          Connect With Us
        </SectionTitle>
        <div className="tf-text-block">
          <p>Follow us on social media for daily plant care tips, inspiration, and updates.</p>
        </div>

        <div className="tf-landscape-wrapper">
          <div className="tf-social-links">
            {socials.map(({ label, href, icon: Icon }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="tf-social-btn"
                aria-label={label}
              >
                <Icon />
              </a>
            ))}
          </div>

          <img
            src="https://res.cloudinary.com/dcfbtdp6r/image/upload/v1783750997/Jul_11_2026_12_01_03_PM_11zon_hmll3w.png"
            alt="Tree Landscape"
            className="tf-trees"
          />
        </div>

        <div className="tf-bottom">
          &copy; {new Date().getFullYear()} Tree Friend. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
