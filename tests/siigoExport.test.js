import XLSX from 'xlsx';
import { generateSiigoExcel } from '../src/utils/siigoExport.js';

const read = (buffer) => {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }).slice(1);
};
const COL = { consecutivo: 1, fecha: 2, cuenta: 5, cuota: 14, descripcion: 19, debito: 21, credito: 22 };

const contract = { excelRowId: 'C-7', lot: { lotNumber: '12', propertyType: 'lotes' }, companyId: { name: 'Proyecto' } };
const quota = (type, number) => ({ type, number, dueDate: new Date('2026-03-05T17:00:00Z') });

describe('Siigo export', () => {
  it('numbers each payment with its receipt and keeps every quota of the payment in one voucher', () => {
    const rows = read(generateSiigoExcel([
      {
        receiptNumber: 57, amount: 1500000, banco: 'NEQUI', fechaPago: new Date('2026-03-01T17:00:00Z'), contractId: contract, clientId: { idNumber: '1' },
        quotas: [{ quotaId: quota('normal', 1), amount: 1000000 }, { quotaId: quota('normal', 2), amount: 500000 }],
      },
      {
        receiptNumber: 58, amount: 200000, banco: 'NEQUI', fechaPago: new Date('2026-03-02T17:00:00Z'), contractId: contract, clientId: { idNumber: '1' },
        quotas: [{ quotaId: quota('normal', 2), amount: 200000 }],
      },
    ]));
    expect(rows.map((r) => r[COL.consecutivo])).toEqual([57, 57, 57, 57, 58, 58]);
  });

  it('tells the separation and the initial quotas apart from ordinary quota 1', () => {
    const rows = read(generateSiigoExcel([{
      receiptNumber: 3, amount: 600000, fechaPago: new Date('2026-03-01T17:00:00Z'), contractId: contract, clientId: { idNumber: '1' },
      quotas: [
        { quotaId: quota('inicial', 0), amount: 100000 },
        { quotaId: quota('inicial', 1), amount: 200000 },
        { quotaId: quota('normal', 1), amount: 300000 },
      ],
    }]));
    expect(rows.filter((_, i) => i % 2 === 0).map((r) => r[COL.descripcion])).toEqual([
      'SEPARACION LOTE 12', 'CUOTA INICIAL 1 LOTE 12', 'CUOTA 1 LOTE 12',
    ]);
  });

  it('does not count the whole payment again for a cascade entry of 0', () => {
    const rows = read(generateSiigoExcel([{
      receiptNumber: 9, amount: 800000, fechaPago: new Date('2026-03-01T17:00:00Z'), contractId: contract, clientId: { idNumber: '1' },
      quotas: [{ quotaId: quota('normal', 1), amount: 800000 }, { quotaId: quota('normal', 2), amount: 0 }],
    }]));
    const credit = rows.reduce((sum, r) => sum + (Number(r[COL.credito]) || 0), 0);
    expect(credit).toBe(800000);
  });

  it('writes the date of the payment in Bogotá, not in the server time zone', () => {
    // 11 p.m. in Bogotá on 1 March is already 2 March in UTC
    const rows = read(generateSiigoExcel([{
      receiptNumber: 1, amount: 100000, fechaPago: new Date('2026-03-02T04:00:00Z'), contractId: contract, clientId: { idNumber: '1' },
      quotas: [{ quotaId: quota('normal', 1), amount: 100000 }],
    }]));
    expect(rows[0][COL.fecha]).toBe('03/01/2026');
  });

  it('a payment without a receipt number gets a voucher after the highest receipt of the export', () => {
    const rows = read(generateSiigoExcel([
      { receiptNumber: 40, amount: 1, fechaPago: new Date(), contractId: contract, clientId: {}, quotas: [{ quotaId: quota('normal', 1), amount: 1 }] },
      { amount: 2, fechaPago: new Date(), contractId: contract, clientId: {}, quotas: [{ quotaId: quota('normal', 2), amount: 2 }] },
    ]));
    expect(rows.map((r) => r[COL.consecutivo])).toEqual([40, 40, 41, 41]);
  });
});
