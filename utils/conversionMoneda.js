// Convierte cualquier monto a su equivalente en USD, usando la tasa vigente
function convertirAUSD(monto, moneda, tasa) {
  const montoNum = Number(monto);

  switch (moneda) {
    case 'USD':
      return montoNum;
    case 'COP':
      return montoNum / Number(tasa.usd_cop);
    case 'VES': {
      // Si el VES/COP fue fijado a mano, usamos esa tasa real (vía COP) en vez de la oficial BCV
      const usdVesEfectivo = tasa.ves_cop_manual
        ? Number(tasa.usd_cop) / Number(tasa.ves_cop)
        : Number(tasa.usd_ves);
      return montoNum / usdVesEfectivo;
    }
    default:
      throw new Error('Moneda no soportada');
  }
}

function calcularRestanteUSD(excluirIndex) {
  const pagadoOtrasLineas = pagos.reduce((acumulado, pago, i) => {
    if (i === excluirIndex) return acumulado;
    return acumulado + convertirAUSD(pago.monto, pago.moneda);
  }, 0);
  return Math.max(0, totalUSD - pagadoOtrasLineas);
}

module.exports = { convertirAUSD, calcularRestanteUSD };