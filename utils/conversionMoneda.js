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

// Precio real de un producto en una moneda dada, respetando: 1) moneda base, 2) precio fijo manual, 3) conversión
function precioEfectivoEnMoneda(producto, moneda, tasa) {
  if (moneda === producto.moneda_base) {
    return Number(producto.precio_venta);
  }
  const campoManual = `precio_manual_${moneda.toLowerCase()}`;
  if (producto[campoManual] != null) {
    return Number(producto[campoManual]);
  }
  const precioBaseUSD = convertirAUSD(producto.precio_venta, producto.moneda_base, tasa);
  return convertirDesdeUSD(precioBaseUSD, moneda, tasa);
}

module.exports = { convertirAUSD, convertirDesdeUSD, precioEfectivoEnMoneda };