// Netlify Function: junta ofertas de varias tiendas y las ordena por % de descuento.
// Uso: /.netlify/functions/ofertas?min=10&q=leche  (el campo "errores" dice qué tienda falló y por qué)
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

const TIENDAS = [
  { n: "Walmart", base: "https://www.walmart.com.sv" },
  { n: "Selectos", base: "https://www.superselectos.com" },
  // { n: "Vidrí", base: "https://..." }, // agrega más aquí
];

const get = async (u, ms = 8000) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(u, { headers: { "user-agent": UA, accept: "application/json" }, signal: c.signal });
  } finally { clearTimeout(t); }
};

// Método VTEX: API pública de catálogo (200 y 206 son respuestas válidas)
async function vtex(t, maxPag = 10) {
  const out = [];
  for (let i = 0; i < maxPag * 50; i += 50) {
    const r = await get(`${t.base}/api/catalog_system/pub/products/search?O=OrderByBestDiscountDESC&_from=${i}&_to=${i + 49}`);
    if (r.status !== 200 && r.status !== 206) { if (!i) throw new Error("HTTP " + r.status); break; }
    const j = await r.json().catch(() => null);
    if (!Array.isArray(j)) { if (!i) throw new Error("No responde como VTEX"); break; }
    let conDesc = 0;
    for (const p of j) {
      for (const sku of p.items || []) {
        const o = sku.sellers?.find(s => s.commertialOffer?.AvailableQuantity > 0)?.commertialOffer;
        if (!o || !(o.ListPrice > o.Price) || o.Price <= 0) continue;
        out.push({
          tienda: t.n, nombre: p.productName, precio: o.Price, antes: o.ListPrice,
          desc: Math.round(100 * (1 - o.Price / o.ListPrice)),
          url: p.link || `${t.base}/${p.linkText}/p`,
          img: sku.images?.[0]?.imageUrl || "",
        });
        conDesc++;
        break; // un SKU por producto
      }
    }
    if (j.length < 50 || !conDesc) break; // ordenado por descuento: ya no hay más ofertas
  }
  return out;
}

exports.handler = async (ev) => {
  const q = ev.queryStringParameters || {};
  const min = +q.min || 0, txt = (q.q || "").toLowerCase();
  const errores = [], todo = [];

  await Promise.all(TIENDAS.map(async t => {
    try { todo.push(...await vtex(t)); }
    catch (e) { errores.push({ tienda: t.n, error: e.message }); }
  }));

  const seen = new Set();
  const datos = todo
    .filter(x => x.desc >= min && x.nombre.toLowerCase().includes(txt))
    .filter(x => !seen.has(x.url) && seen.add(x.url))
    .sort((a, b) => b.desc - a.desc)
    .slice(0, 200);

  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=1800" },
    body: JSON.stringify({ actualizado: new Date().toISOString(), errores, datos }),
  };
};
