"use client";

import { signIn } from "next-auth/react";
import { TrendingUp, Globe, Shield, Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/ThemeContext";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/>
      <path d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.548 0 9s.348 2.825.957 4.039l3.007-2.332z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" fill="#EA4335"/>
    </svg>
  );
}

const content = {
  en: {
    tagline: "Your personal",
    highlight: "Search Console",
    tagline2: "command center",
    sub: "Your Google account, all your sites — one clean dashboard. No limits, no noise, no subscription.",
    features: [
      { title: "All sites in one place", desc: "See every GSC property available to your Google account on a single dashboard." },
      { title: "Traffic at a glance", desc: "Sparkline charts for every site. Instantly spot winners, drops, and trends." },
      { title: "Your data, your server", desc: "Self-hosted. Your Search Console data never leaves your VPS." },
    ],
    getStarted: "Get started",
    signInSub: "Sign in with the Google account that will own this dashboard.",
    signIn: "Sign in with Google",
    bullets: ["Google OAuth only — no passwords", "Single-owner dashboard", "Self-hosted on your VPS"],
  },
  ru: {
    tagline: "Твой личный",
    highlight: "Search Console",
    tagline2: "командный центр",
    sub: "Твой Google аккаунт, все сайты — одна чистая панель. Без лимитов, без шума, без подписки.",
    features: [
      { title: "Все сайты в одном месте", desc: "Смотри все GSC-сайты, доступные твоему Google аккаунту, на одном экране." },
      { title: "Трафик с первого взгляда", desc: "Мини-графики для каждого сайта. Сразу видно рост, падения и тренды." },
      { title: "Твои данные, твой сервер", desc: "Self-hosted. Данные Search Console никуда не уходят с твоего VPS." },
    ],
    getStarted: "Войти",
    signInSub: "Войди через Google аккаунт, который будет владельцем этого дашборда.",
    signIn: "Войти через Google",
    bullets: ["Только Google OAuth — никаких паролей", "Дашборд с одним владельцем", "Self-hosted на вашем VPS"],
  },
  uk: {
    tagline: "Твій особистий",
    highlight: "Search Console",
    tagline2: "командний центр",
    sub: "Твій Google акаунт, усі сайти — одна чиста панель. Без лімітів, без шуму, без підписки.",
    features: [
      { title: "Усі сайти в одному місці", desc: "Дивись усі GSC-сайти, доступні твоєму Google акаунту, на одному екрані." },
      { title: "Трафік з першого погляду", desc: "Міні-графіки для кожного сайту. Одразу видно зростання, падіння і тренди." },
      { title: "Твої дані, твій сервер", desc: "Self-hosted. Дані Search Console нікуди не залишають твій VPS." },
    ],
    getStarted: "Увійти",
    signInSub: "Увійди через Google акаунт, який буде власником цього дашборду.",
    signIn: "Увійти через Google",
    bullets: ["Лише Google OAuth — без паролів", "Дашборд з одним власником", "Self-hosted на вашому VPS"],
  },
  fr: {
    tagline: "Votre",
    highlight: "Search Console",
    tagline2: "personnel",
    sub: "Votre compte Google, tous vos sites — un tableau de bord épuré. Sans limites, sans bruit, sans abonnement.",
    features: [
      { title: "Tous vos sites au même endroit", desc: "Consultez sur un seul écran tous les sites GSC accessibles à votre compte Google." },
      { title: "Le trafic d'un coup d'œil", desc: "Des mini-graphiques pour chaque site. Repérez aussitôt les gains, les chutes et les tendances." },
      { title: "Vos données, votre serveur", desc: "Self-hosted. Vos données Search Console ne quittent jamais votre VPS." },
    ],
    getStarted: "Commencer",
    signInSub: "Connectez-vous avec le compte Google qui sera propriétaire de ce tableau de bord.",
    signIn: "Se connecter avec Google",
    bullets: ["Google OAuth uniquement — aucun mot de passe", "Tableau de bord à propriétaire unique", "Self-hosted sur votre VPS"],
  },
  es: {
    tagline: "Tu",
    highlight: "Search Console",
    tagline2: "personal",
    sub: "Tu cuenta de Google, todos tus sitios — un panel limpio. Sin límites, sin ruido, sin suscripción.",
    features: [
      { title: "Todos tus sitios en un solo lugar", desc: "Ve en una sola pantalla todos los sitios de GSC disponibles para tu cuenta de Google." },
      { title: "El tráfico de un vistazo", desc: "Minigráficas para cada sitio. Detecta al instante las subidas, las caídas y las tendencias." },
      { title: "Tus datos, tu servidor", desc: "Self-hosted. Los datos de Search Console nunca salen de tu VPS." },
    ],
    getStarted: "Empezar",
    signInSub: "Inicia sesión con la cuenta de Google que será la propietaria de este panel.",
    signIn: "Iniciar sesión con Google",
    bullets: ["Solo Google OAuth — sin contraseñas", "Panel con un único propietario", "Self-hosted en tu VPS"],
  },
  de: {
    tagline: "Dein persönliches",
    highlight: "Search Console",
    tagline2: "Kontrollzentrum",
    sub: "Dein Google-Konto, alle deine Websites — ein aufgeräumtes Dashboard. Keine Limits, kein Rauschen, kein Abo.",
    features: [
      { title: "Alle Websites an einem Ort", desc: "Sieh alle GSC-Websites, auf die dein Google-Konto zugreifen kann, auf einem Bildschirm." },
      { title: "Traffic auf einen Blick", desc: "Mini-Diagramme für jede Website. Gewinner, Einbrüche und Trends sofort erkennen." },
      { title: "Deine Daten, dein Server", desc: "Self-hosted. Deine Search-Console-Daten verlassen nie deinen VPS." },
    ],
    getStarted: "Loslegen",
    signInSub: "Melde dich mit dem Google-Konto an, das Inhaber dieses Dashboards wird.",
    signIn: "Mit Google anmelden",
    bullets: ["Nur Google OAuth — keine Passwörter", "Dashboard mit einem Inhaber", "Self-hosted auf deinem VPS"],
  },
  zh: {
    tagline: "你的专属",
    highlight: "Search Console",
    tagline2: "指挥中心",
    sub: "你的 Google 账号、所有网站 —— 一个清爽的仪表盘。无限制、无干扰、无订阅。",
    features: [
      { title: "所有网站集中管理", desc: "在同一块屏幕上查看你的 Google 账号可访问的所有 GSC 网站。" },
      { title: "流量一目了然", desc: "每个站点都有迷你走势图，立刻看出上涨、下跌和趋势。" },
      { title: "你的数据，你的服务器", desc: "Self-hosted。Search Console 数据永远不会离开你的 VPS。" },
    ],
    getStarted: "开始使用",
    signInSub: "使用将成为本仪表盘所有者的 Google 账号登录。",
    signIn: "使用 Google 登录",
    bullets: ["仅支持 Google OAuth —— 无需密码", "单一所有者仪表盘", "Self-hosted 在你的 VPS 上"],
  },
};

const featureIcons = [
  <Globe size={18} key="globe" />,
  <TrendingUp size={18} key="trend" />,
  <Shield size={18} key="shield" />,
];

export default function LoginPage() {
  const { dark, setDark } = useTheme();
  const { language, setLanguage } = useLanguage();
  const c = content[language];

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      background: "var(--color-bg)",
      overflow: "hidden",
      position: "relative",
    }}>
      {/* ── Top-right controls ── */}
      <div style={{
        position: "fixed", top: "16px", right: "20px",
        display: "flex", alignItems: "center", gap: "8px",
        zIndex: 10,
      }}>
        {/* Language toggle */}
        <div style={{
          display: "flex", alignItems: "center",
          background: "var(--color-card)",
          border: "1px solid var(--color-border)",
          borderRadius: "8px", overflow: "hidden",
        }}>
          {(["en", "ru", "uk", "fr", "es", "de", "zh"] as const).map(lang => (
            <button
              key={lang}
              onClick={() => setLanguage(lang)}
              style={{
                padding: "6px 9px",
                fontSize: "12px", fontWeight: 600,
                border: "none", cursor: "pointer",
                background: language === lang ? "var(--color-accent-purple)" : "transparent",
                color: language === lang ? "#fff" : "var(--color-text-secondary)",
                transition: "all 0.15s",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {lang}
            </button>
          ))}
        </div>

        {/* Theme toggle */}
        <button
          onClick={() => setDark(!dark)}
          style={{
            display: "flex", alignItems: "center", gap: "6px",
            padding: "6px 12px",
            background: "var(--color-card)",
            border: "1px solid var(--color-border)",
            borderRadius: "8px",
            fontSize: "12px", fontWeight: 600,
            color: "var(--color-text-secondary)",
            cursor: "pointer", transition: "all 0.15s",
          }}
          onMouseOver={e => e.currentTarget.style.borderColor = "var(--color-accent-purple)"}
          onMouseOut={e => e.currentTarget.style.borderColor = "var(--color-border)"}
        >
          {dark
            ? <><Sun size={13} /> Light</>
            : <><Moon size={13} /> Dark</>}
        </button>
      </div>

      {/* ── Left panel ── */}
      <div style={{
        flex: "1 1 55%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "60px 64px",
        position: "relative",
      }}>
        {/* Background glow */}
        <div style={{
          position: "absolute", top: "10%", left: "-10%",
          width: "500px", height: "500px", borderRadius: "50%",
          background: "radial-gradient(ellipse, rgba(139,92,246,0.13) 0%, transparent 70%)",
          pointerEvents: "none",
        }} />

        {/* Logo */}
        <div style={{ marginBottom: "56px" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="OpenGSC" height={36} style={{ display: "block" }} />
        </div>

        {/* Headline */}
        <h1 style={{
          fontSize: "48px", fontWeight: 800, lineHeight: 1.1,
          letterSpacing: "-0.04em", color: "var(--color-text-primary)",
          marginBottom: "20px", maxWidth: "480px",
        }}>
          {c.tagline}<br />
          <span style={{ color: "var(--color-accent-purple)" }}>{c.highlight}</span><br />
          {c.tagline2}
        </h1>
        <p style={{
          fontSize: "16px", color: "var(--color-text-secondary)",
          lineHeight: 1.7, marginBottom: "48px", maxWidth: "400px",
        }}>
          {c.sub}
        </p>

        {/* Features */}
        <div style={{ display: "flex", flexDirection: "column", gap: "20px", maxWidth: "420px" }}>
          {c.features.map((f, i) => (
            <div key={f.title} style={{ display: "flex", gap: "14px", alignItems: "flex-start" }}>
              <div style={{
                flexShrink: 0, width: "36px", height: "36px", borderRadius: "9px",
                background: "rgba(139,92,246,0.12)",
                border: "1px solid rgba(139,92,246,0.2)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--color-accent-purple)",
              }}>
                {featureIcons[i]}
              </div>
              <div>
                <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "2px" }}>
                  {f.title}
                </div>
                <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                  {f.desc}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Right panel ── */}
      <div style={{
        flex: "0 0 420px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 48px",
        borderLeft: "1px solid var(--color-border)",
        background: "var(--color-card)",
        position: "relative",
      }}>
        <div style={{ width: "100%", maxWidth: "320px" }}>
          <h2 style={{ fontSize: "22px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "8px" }}>
            {c.getStarted}
          </h2>
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "32px", lineHeight: 1.6 }}>
            {c.signInSub}
          </p>

          <button
            onClick={() => signIn("google", { callbackUrl: "/" })}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: "12px",
              width: "100%", padding: "14px 20px",
              borderRadius: "10px",
              background: "#fff",
              color: "#1f2937",
              fontSize: "15px", fontWeight: 600,
              border: "none", cursor: "pointer",
              boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
              transition: "box-shadow 0.2s, transform 0.15s",
            }}
            onMouseOver={e => {
              e.currentTarget.style.boxShadow = "0 6px 20px rgba(0,0,0,0.3)";
              e.currentTarget.style.transform = "translateY(-1px)";
            }}
            onMouseOut={e => {
              e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.2)";
              e.currentTarget.style.transform = "translateY(0)";
            }}
          >
            <GoogleIcon />
            {c.signIn}
          </button>

          <div style={{ margin: "28px 0", height: "1px", background: "var(--color-border)" }} />

          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {c.bullets.map(item => (
              <div key={item} style={{ fontSize: "12px", color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ color: "var(--color-accent-green)", fontSize: "14px" }}>✓</span>
                {item}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
