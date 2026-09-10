const { redondear } = require('./redondeo');

function convertirAUSD(monto, moneda, tasa) {
  const montoNum = Number(monto);

  switch (moneda) {
    case 'USD':
      return montoNum;
    case 'COP':
      return montoNum / Number(tasa.usd_cop);
    case 'VES': {
      const usdVesEfectivo = tasa.ves_cop_manual
        ? Number(tasa.usd_cop) / Number(tasa.ves_cop)
        : Number(tasa.usd_ves);
      return montoNum / usdVesEfectivo;
    }
    default:
      throw new Error('Moneda no soportada');
  }
}

function convertirDesdeUSD(montoUSD, moneda, tasa) {
  const monto = Number(montoUSD);

  switch (moneda) {
    case 'USD':
      return monto;
    case 'COP':
      return monto * Number(tasa.usd_cop);
    case 'VES': {
      const usdVesEfectivo = tasa.ves_cop_manual
        ? Number(tasa.usd_cop) / Number(tasa.ves_cop)
        : Number(tasa.usd_ves);
      return monto * usdVesEfectivo;
    }
    default:
      throw new Error('Moneda no soportada');
  }
}

// Precio exacto de un producto en una moneda dada, con prioridad:
// 1) Si es la moneda base -> precio_venta tal cual (sin conversión)
// 2) Si hay precio fijo para ESA moneda -> se usa tal cual
// 3) Si se pide VES y hay precio fijo en COP (o viceversa) -> se cruza DIRECTO por la tasa VES/COP,
//    sin pasar por el precio en dólares (evita el bug de "recalcula desde USD")
// 4) Si no hay nada fijo -> se convierte desde el precio base con la tasa oficial
function precioEfectivoEnMoneda(producto, monedaDestino, tasa) {
  if (monedaDestino === producto.moneda_base) {
    return Number(producto.precio_venta);
  }

  const manualDestino = producto[`precio_manual_${monedaDestino.toLowerCase()}`];
  if (manualDestino != null) {
    return Number(manualDestino);
  }

  if (monedaDestino === 'VES' && producto.precio_manual_cop != null) {
    const usd = convertirAUSD(producto.precio_manual_cop, 'COP', tasa);
    return convertirDesdeUSD(usd, 'VES', tasa);
  }
  if (monedaDestino === 'COP' && producto.precio_manual_ves != null) {
    const usd = convertirAUSD(producto.precio_manual_ves, 'VES', tasa);
    return convertirDesdeUSD(usd, 'COP', tasa);
  }

  const usdBase = convertirAUSD(producto.precio_venta, producto.moneda_base, tasa);
  return convertirDesdeUSD(usdBase, monedaDestino, tasa);
}

module.exports = { convertirAUSD, convertirDesdeUSD, precioEfectivoEnMoneda, redondear };