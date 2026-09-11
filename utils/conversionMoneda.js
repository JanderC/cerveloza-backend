const { redondear } = require('./redondeo');

function convertirAUSD(monto, moneda, tasa) {
  const montoNum = Number(monto);
  switch (moneda) {
    case 'USD': return montoNum;
    case 'COP': return montoNum / Number(tasa.usd_cop);
    case 'VES': {
      const usdVesEfectivo = tasa.ves_cop_manual
        ? Number(tasa.usd_cop) / Number(tasa.ves_cop)
        : Number(tasa.usd_ves);
      return montoNum / usdVesEfectivo;
    }
    default: throw new Error('Moneda no soportada');
  }
}

function convertirDesdeUSD(montoUSD, moneda, tasa) {
  const monto = Number(montoUSD);
  switch (moneda) {
    case 'USD': return monto;
    case 'COP': return monto * Number(tasa.usd_cop);
    case 'VES': {
      const usdVesEfectivo = tasa.ves_cop_manual
        ? Number(tasa.usd_cop) / Number(tasa.ves_cop)
        : Number(tasa.usd_ves);
      return monto * usdVesEfectivo;
    }
    default: throw new Error('Moneda no soportada');
  }
}

// Convierte entre 2 monedas cualquiera. Si son la misma, devuelve el monto TAL CUAL (sin ninguna
// operación matemática) — esto es lo que elimina el error de decimales cuando se vende y se paga
// en la misma moneda, que es el caso más común.
function convertirEntreMonedas(monto, monedaOrigen, monedaDestino, tasa) {
  if (monedaOrigen === monedaDestino) return Number(monto);
  const usd = convertirAUSD(monto, monedaOrigen, tasa);
  return convertirDesdeUSD(usd, monedaDestino, tasa);
}

function precioEfectivoEnMoneda(producto, monedaDestino, tasa) {
  if (monedaDestino === producto.moneda_base) {
    return Number(producto.precio_venta);
  }
  const manualDestino = producto[`precio_manual_${monedaDestino.toLowerCase()}`];
  if (manualDestino != null) {
    return Number(manualDestino);
  }
  if (monedaDestino === 'VES' && producto.precio_manual_cop != null) {
    return convertirEntreMonedas(producto.precio_manual_cop, 'COP', 'VES', tasa);
  }
  if (monedaDestino === 'COP' && producto.precio_manual_ves != null) {
    return convertirEntreMonedas(producto.precio_manual_ves, 'VES', 'COP', tasa);
  }
  return convertirEntreMonedas(producto.precio_venta, producto.moneda_base, monedaDestino, tasa);
}

module.exports = { convertirAUSD, convertirDesdeUSD, convertirEntreMonedas, precioEfectivoEnMoneda, redondear };