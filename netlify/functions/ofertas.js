// Ofertas multi-tienda. ?min=10&q=leche  |  ?diag=1 para diagnosticar cada tienda
const H = {
  "user-agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
  accept: "text/html,application/json;q=0.9,*/*;q=0.8",
  "accept-language": "es-SV,es;q=0.9",
};

const TIENDAS = [
  { n: "Walmart", base: "https://www.walmart.com.sv", tipo: "vtex" },
  { n: "EPA", base: "https://sv.epaenlinea.com", tipo: "magento",
    paths: ["/promociones/ofertas.html", "/promociones/liquidacion.html"] },
  { n: "Selectos", base: "https://superselectos.com" },
  { n: "Vidrí", base: "https://vidri.com.sv" },
  // { n: "Prado", base: "https://www.prado.com.sv" },
];

const get = async (u, ms = 4500) => {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { return await fetch(u, { headers: H, signal: c.signal }); } finally { clearTimeout(t); }
};
const J = async (u) => {
  const r = await get(u);
  if (r.status !== 200 && r.status !== 206) throw new Error("HTTP " + r.status);
  try { return await r.json(); } catch { throw new Error("no es JSON"); }
};
const dec = s => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").trim();
const attr = (tag, a) => (tag.match(new RegExp(a + '="([^"]*)"')) || [])[1];
const oferta = (t, nombre, precio, antes, url, img) =>
  precio > 0 && antes > precio
    ? { tienda: t.n, nombre, precio, antes, desc: Math.round(100 * (1 - precio / antes)), url, img: img || "" }
    : null;

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

async function shopify(t, out) {
  for (let p = 1; p <= 3; p++) {
    const j = await J(`${t.base}/products.json?limit=250&page=${p}`);
    if (!Array.isArray(j.products)) throw new Error("no Shopify");
    for (const pr of j.products) {
      const v = pr.variants.filter(v => v.available)
        .map(v => oferta(t, pr.title, +v.price, +v.compare_at_price, `${t.base}/products/${pr.handle}`, pr.images?.[0]?.src))
        .filter(Boolean).sort((a, b) => b.desc - a.desc)[0];
      if (v) out.push(v);
    }
    if (j.products.length < 250) break;
  }
}

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

// Magento: lee las páginas de listado de promociones (HTML) y saca precios de data-price-amount
async function magento(t, out) {
  const urls = [];
  for (const p of t.paths || ["/promociones/ofertas.html"])
    for (let n = 1; n <= 6; n++) urls.push(`${t.base}${p}?p=${n}&product_list_limit=32`);
  let tarjetas = 0, ultimo = "";
  await Promise.all(urls.map(async u => {
    try {
      const r = await get(u);
      if (!r.ok) { ultimo = "HTTP " + r.status; return; }
      for (const c of (await r.text()).split(/class="[^"]*product-item-info/).slice(1)) {
        const a = c.match(/<a[^>]*product-item-link[^>]*>\s*([\s\S]*?)<\/a>/);
        const tag = c.match(/<a[^>]*product-item-link[^>]*>/)?.[0];
        if (!a || !tag) continue;
        tarjetas++;
        const pr = {};
        for (const m of c.matchAll(/<[^>]*data-price-type="(finalPrice|oldPrice)"[^>]*>/g))
          pr[m[1]] ??= +attr(m[0], "data-price-amount");
        const img = c.match(/<img[^>]+(?:data-src|src)="([^"]+)"/)?.[1];
        const x = oferta(t, dec(a[1]), pr.finalPrice, pr.oldPrice, attr(tag, "href"), img);
        if (x) out.push(x);
      }
    } catch (e) { ultimo = e.message; }
  }));
  if (!tarjetas) throw new Error("sin tarjetas Magento " + ultimo);
}

const M = { vtex, shopify, woo, magento };

async function tienda(t) {
  const ms = t.tipo ? [t.tipo] : ["vtex", "shopify", "woo"];
  const rs = await Promise.allSettled(ms.map(async m => { const o = []; await M[m](t, o); return o; }));
  const ok = rs.find(r => r.status === "fulfilled");
  if (ok) return ok.value;
  throw new Error(rs.map((r, i) => ms[i] + ": " + r.reason.message).join(" | "));
}

// Diagnóstico: "visita" la home y prueba cada método
async function diag(t) {
  const r = { tienda: t.n, base: t.base, metodos: {} };
  try {
    const x = await get(t.base + "/", 6000), h = await x.text(), l = h.toLowerCase();
    r.home = {
      status: x.status, final: x.url, server: x.headers.get("server"), bytes: h.length,
      titulo: (h.match(/<title>([^<]*)/i) || [])[1],
      huellas: ["vtex", "shopify", "woocommerce", "wp-content", "magento", "mage-", "__next_data__", "ng-version",
        "nuxt", "cloudflare", "datadome", "akamai", "captcha", "/graphql"].filter(k => l.includes(k)),
    };
  } catch (e) { r.home = { error: e.message }; }
  await Promise.all(Object.keys(M).map(async m => {
    try { const o = []; await M[m]({ ...t, paths: t.paths }, o); r.metodos[m] = o.length + " ofertas"; }
    catch (e) { r.metodos[m] = "falló: " + e.message; }
  }));
  return r;
}

exports.handler = async (ev) => {
  const q = ev.queryStringParameters || {};
  if (q.diag) {
    const d = await Promise.all(TIENDAS.map(diag));
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(d, null, 1) };
  }
  const min = +q.min || 0, txt = (q.q || "").toLowerCase();
  const errores = [], todo = [];
  await Promise.all(TIENDAS.map(async t => {
    try {
      todo.push(...await Promise.race([tienda(t), new Promise((_, no) => setTimeout(() => no(new Error("tiempo agotado")), 8500))]));
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
