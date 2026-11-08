import { z } from 'zod';

const isoDate = z.string().refine(val => !isNaN(Date.parse(val)), { message: 'La fecha del contrato debe ser una fecha válida' });

export const reserveLotValidation = z.object({
  body: z.object({
    type: z.enum(['apartado', 'separado'], { 
      required_error: 'El tipo de reserva debe ser "apartado" o "separado"', 
      invalid_type_error: 'El tipo de reserva debe ser "apartado" o "separado"' 
    }),
    clientId: z.string()
      .regex(/^[0-9a-fA-F]{24}$/, 'ID de cliente inválido')
      .optional(),
    clientData: z.record(z.string(), z.any()).optional(),
    amount: z.coerce.number({ invalid_type_error: 'El monto debe ser un número' })
      .optional(),
    expirationDays: z.coerce.number({ invalid_type_error: 'Los días de expiración deben ser un número' })
      .optional()
  }).refine(data => {
    if (data.type === 'separado' && (!data.amount || data.amount < 500000)) {
      return false;
    }
    return true;
  }, {
    message: 'Para separar se requiere un monto mínimo de $500,000',
    path: ['amount']
  }).refine(data => {
    if (data.type === 'separado' && data.expirationDays && data.expirationDays > 30) {
      return false;
    }
    return true;
  }, {
    message: 'El plazo de separación no puede superar los 30 días',
    path: ['expirationDays']
  })
});

export const sellLotValidation = z.object({
  body: z.object({
    totalValue: z.coerce.number({ invalid_type_error: 'El valor total debe ser un número' })
      .optional(),
    installmentsCount: z.coerce.number()
      .int()
      .min(0, 'El número de cuotas debe ser un entero positivo')
      .optional(),
    initialQuotaPercentage: z.coerce.number()
      .min(0, 'El porcentaje de cuota inicial debe estar entre 0 y 100')
      .max(100, 'El porcentaje de cuota inicial debe estar entre 0 y 100')
      .optional(),
    contractDate: isoDate
      .optional(),
    paymentDay: z.coerce.number({ invalid_type_error: 'El día de pago debe ser un número' })
      .int()
      .min(1, 'El día de pago debe estar entre 1 y 31')
      .max(31, 'El día de pago debe estar entre 1 y 31')
      .optional(),
    initialQuotaMode: z.enum(['free', 'fixed'], {
      invalid_type_error: 'El modo de la cuota inicial debe ser abonos libres o cuotas fijas',
    }).optional(),
    initialQuotasCount: z.coerce.number()
      .int()
      .min(1, 'El número de cuotas iniciales debe ser al menos 1')
      .optional(),
    earlyStart: z.boolean().optional(),
  })
});

export const releaseLotValidation = z.object({
  body: z.object({
    reason: z.string({ required_error: 'La razón de liberación es obligatoria' })
      .min(1, 'La razón de liberación es obligatoria')
  })
});

export const createLotValidation = z.object({
  body: z.object({
    stage: z.string().optional(),
    manzana: z.string().optional(),
    nomenclature: z.string().optional(),
    lotNumber: z.string({ required_error: 'El número de inmueble es obligatorio' })
      .min(1, 'El número de inmueble es obligatorio'),
    area: z.coerce.number({ 
      required_error: 'El área es obligatoria', 
      invalid_type_error: 'El área debe ser un número' 
    }).positive('El área debe ser mayor a 0'),
    price: z.coerce.number({ invalid_type_error: 'El precio debe ser un número' })
      .min(0, 'El precio no puede ser negativo')
      .optional(),
    propertyType: z.enum(['lotes', 'casas', 'apartamentos', 'locales']).optional(),
    tower: z.string().optional(),
    floor: z.string().optional(),
    status: z.enum(['disponible', 'apartado', 'separado', 'vendido']).optional(),
    maxInstallments: z.coerce.number().int().min(1).optional(),
    images: z.array(z.string()).optional(),
  })
});

export const updateLotValidation = z.object({
  body: z.object({
    stage: z.string().optional(),
    manzana: z.string().optional(),
    nomenclature: z.string().optional(),
    lotNumber: z.string().min(1).optional(),
    area: z.coerce.number({ invalid_type_error: 'El área debe ser un número' })
      .positive('El área debe ser mayor a 0')
      .optional(),
    price: z.coerce.number({ invalid_type_error: 'El precio debe ser un número' })
      .min(0, 'El precio no puede ser negativo')
      .optional(),
    propertyType: z.enum(['lotes', 'casas', 'apartamentos', 'locales']).optional(),
    tower: z.string().optional(),
    floor: z.string().optional(),
    status: z.enum(['disponible', 'apartado', 'separado', 'vendido']).optional(),
    maxInstallments: z.coerce.number().int().min(1).optional(),
    images: z.array(z.string()).optional(),
  })
});

