// Netlify Function: ofertas de varias tiendas, ordenadas por % de descuento.
// Uso: /.netlify/functions/ofertas?min=10&q=leche
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

const TIENDAS = [
  { n: "Walmart", base: "https://www.walmart.com.sv" },
  { n: "Selectos", base: "https://www.superselectos.com" },
  { n: "Vidrí", base: "https://www.vidri.com.sv" },
  { n: "Freund", base: "https://www.freundferreteria.com" },
  { n: "EPA", base: "https://www.epa.com.sv" },
  { n: "La Curacao", base: "https://www.lacuracaoonline.com" },
  { n: "Prado", base: "https://www.prado.com.sv" },
];

const get = async (u, ms = 4000) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(u, { headers: { "user-agent": UA, accept: "application/json" }, signal: c.signal }); }
  finally { clearTimeout(t); }
};
const J = async (u) => {
  const r = await get(u);
  if (r.status !== 200 && r.status !== 206) throw new Error("HTTP " + r.status);
  try { return await r.json(); } catch { throw new Error("no es JSON"); }
};
const oferta = (t, nombre, precio, antes, url, img) =>
  precio > 0 && antes > precio
    ? { tienda: t.n, nombre, precio, antes, desc: Math.round(100 * (1 - precio / antes)), url, img: img || "" }
    : null;

// VTEX
async function vtex(t, out) {
  for (let i = 0; i < 200; i += 50) {
    const j = await J(`${t.base}/api/catalog_system/pub/products/search?O=OrderByBestDiscountDESC&_from=${i}&_to=${i + 49}`);
    if (!Array.isArray(j)) throw new Error("no VTEX");
    let n = 0;
    for (const p of j) for (const s of p.items || []) {
      const o = s.sellers?.find(x => x.commertialOffer?.AvailableQuantity > 0)?.commertialOffer;
      const x = o && oferta(t, p.productName, o.Price, o.ListPrice, p.link || `${t.base}/${p.linkText}/p`, s.images?.[0]?.imageUrl);
      if (x) { out.push(x); n++; break; }
    }
    if (j.length < 50 || !n) break;
  }
}

// Shopify
async function shopify(t, out) {
  for (let p = 1; p <= 3; p++) {
    const j = await J(`${t.base}/products.json?limit=250&page=${p}`);
    if (!Array.isArray(j.products)) throw new Error("no Shopify");
    for (const pr of j.products) {
      const v = pr.variants.filter(v => v.available).map(v => oferta(t, pr.title, +v.price, +v.compare_at_price,
        `${t.base}/products/${pr.handle}`, pr.images?.[0]?.src)).filter(Boolean).sort((a, b) => b.desc - a.desc)[0];
      if (v) out.push(v);
    }
    if (j.products.length < 250) break;
  }
}

// WooCommerce
async function woo(t, out) {
  for (let p = 1; p <= 3; p++) {
    const j = await J(`${t.base}/wp-json/wc/store/v1/products?on_sale=true&per_page=100&page=${p}`);
    if (!Array.isArray(j)) throw new Error("no Woo");
    for (const pr of j) {
      const d = 10 ** (pr.prices.currency_minor_unit ?? 2);
      const x = pr.is_in_stock && oferta(t, pr.name, +pr.prices.price / d, +pr.prices.regular_price / d, pr.permalink, pr.images?.[0]?.src);
      if (x) out.push(x);
    }
    if (j.length < 100) break;
  }
}

async function tienda(t) {
  const rs = await Promise.allSettled([vtex, shopify, woo].map(async m => { const o = []; await m(t, o); return o; }));
  const ok = rs.find(r => r.status === "fulfilled");
  if (ok) return ok.value;
  throw new Error(rs.map((r, i) => ["vtex", "shopify", "woo"][i] + ": " + r.reason.message).join(" | "));
}

exports.handler = async (ev) => {
  const q = ev.queryStringParameters || {};
  const min = +q.min || 0, txt = (q.q || "").toLowerCase();
  const errores = [], todo = [];

  await Promise.all(TIENDAS.map(async t => {
    try {
      const r = await Promise.race([tienda(t), new Promise((_, no) => setTimeout(() => no(new Error("tiempo agotado")), 8500))]);
      todo.push(...r);
    } catch (e) { errores.push({ tienda: t.n, error: e.message }); }
  }));

  const seen = new Set();
  const datos = todo
    .filter(x => x.desc >= min && x.nombre.toLowerCase().includes(txt))
    .filter(x => !seen.has(x.url) && seen.add(x.url))
    .sort((a, b) => b.desc - a.desc)
    .slice(0, 300);

  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=1800" },
    body: JSON.stringify({ actualizado: new Date().toISOString(), errores, datos }),
  };
};
