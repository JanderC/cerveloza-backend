// Convierte cualquier monto a su equivalente en USD, usando la tasa vigente
function convertirAUSD(monto, moneda, tasa) {
  const montoNum = Number(monto);

  switch (moneda) {
    case 'USD':
      return montoNum;
    case 'VES':
      return montoNum / Number(tasa.usd_ves);
    case 'COP':
      return montoNum / Number(tasa.usd_cop);
    default:
      throw new Error('Moneda no soportada');
  }
}

module.exports = { convertirAUSD };