export interface Product {
	readonly id: 'journal' | 'handbook' | 'bundle';
	readonly name: string;
	readonly priceUsd: number;
	readonly checkoutUrl: string;
	readonly cta: string;
}

export const products: readonly Product[] = [
	{
		id: 'journal',
		name: 'Journal',
		priceUsd: 9,
		checkoutUrl: 'https://buy.stripe.com/14A00i48h5Hq3EV91MgUM00',
		cta: 'Buy Journal',
	},
	{
		id: 'handbook',
		name: 'Handbook',
		priceUsd: 24,
		checkoutUrl: 'https://buy.stripe.com/aFaeVcgV3fi0dfvguegUM01',
		cta: 'Buy Handbook',
	},
	{
		id: 'bundle',
		name: 'Bundle',
		priceUsd: 29,
		checkoutUrl: 'https://buy.stripe.com/aFa00idIR4DmgrHcdYgUM02',
		cta: 'Buy Bundle',
	},
];

export function formatPrice(product: Product): string {
	return `$${product.priceUsd} USD`;
}
