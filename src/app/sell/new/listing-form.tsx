"use client";

import { startTransition, useActionState, useState } from "react";
import type { FormState } from "@/app/actions/auth";
import { submitListingAction } from "@/app/actions/listings";
import { FormMessage, SubmitButton } from "@/components/form";
import type { Attestation } from "@/domains/compliance/provenance-template";
import { formatUsd, parseUsdToCents, priceBreakdown, type FeeRates } from "@/domains/pricing/pricing";

interface CategoryOption {
  id: string;
  label: string;
  isNativeAmerican: boolean;
  requiresEnhancedReview: boolean;
}

interface Props {
  rates: FeeRates;
  legalName: string;
  iacaDisclosure: string;
  template: { version: number; isDraft: boolean; body: string; attestations: Attestation[] };
  categories: CategoryOption[];
}

const ACQUISITION_SOURCES = [
  { value: "PURCHASED", label: "Purchased (dealer, auction, estate sale, private sale)" },
  { value: "INHERITED", label: "Inherited or gifted" },
  { value: "PRIVATE_LAND_WITH_PERMISSION", label: "Found on private land with the landowner's permission" },
  { value: "OTHER", label: "Other (explain below)" },
] as const;

const initial: FormState = { status: "idle" };

const inputClass =
  "block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200";

function Errors({ errors }: { errors?: string[] }) {
  return (
    <>
      {errors?.map((e) => (
        <span key={e} className="block text-xs text-red-700">
          {e}
        </span>
      ))}
    </>
  );
}

function TextInput(props: {
  label: string;
  name: string;
  errors?: string[];
  hint?: string;
  required?: boolean;
  inputMode?: "decimal" | "numeric";
  placeholder?: string;
  value?: string;
  onChange?: (v: string) => void;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-stone-800">
        {props.label}
        {props.required && <span className="text-red-700"> *</span>}
      </span>
      <input
        name={props.name}
        required={props.required}
        inputMode={props.inputMode}
        placeholder={props.placeholder}
        value={props.value}
        onChange={props.onChange ? (e) => props.onChange?.(e.target.value) : undefined}
        className={inputClass}
      />
      {props.hint && !props.errors?.length && <span className="block text-xs text-stone-500">{props.hint}</span>}
      <Errors errors={props.errors} />
    </label>
  );
}

export function ListingForm({ rates, legalName, iacaDisclosure, template, categories }: Props) {
  const [state, action, pending] = useActionState(submitListingAction, initial);
  const [askingInput, setAskingInput] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [source, setSource] = useState("");
  const errors = state.status === "error" ? state.fieldErrors : undefined;

  const category = categories.find((c) => c.id === categoryId);
  const nativeAmerican = category?.isNativeAmerican ?? false;
  const askingCents = parseUsdToCents(askingInput);
  const prices = askingCents !== null && askingCents > 0 ? priceBreakdown(askingCents, rates) : null;
  const pct = (bps: number) => `${bps / 100}%`;

  return (
    <form
      className="space-y-8"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <div>
        <h1 className="font-serif text-2xl font-semibold">New listing</h1>
        <p className="mt-1 text-sm text-stone-600">
          Fixed-price only during the beta. Every listing is reviewed by our compliance team before
          it goes live.
        </p>
      </div>

      <section className="space-y-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">The item</h2>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-stone-800">
            Category<span className="text-red-700"> *</span>
          </span>
          <select
            name="categoryId"
            required
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className={inputClass}
          >
            <option value="">Choose a category…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <Errors errors={errors?.categoryId} />
        </label>
        <TextInput label="Title" name="title" required errors={errors?.title} />
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-stone-800">
            Description<span className="text-red-700"> *</span>
          </span>
          <textarea name="description" required rows={5} className={inputClass} />
          <Errors errors={errors?.description} />
        </label>
        <TextInput
          label="Condition"
          name="sellerConditionGrade"
          hint="Your own description, e.g. “Very good, small tip ding”."
          errors={errors?.sellerConditionGrade}
        />
        {nativeAmerican && (
          <div className="space-y-4 rounded-xl border border-amber-200 bg-amber-50/60 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
              Native American category: extra details required
            </p>
            <TextInput label="Region of origin" name="regionOfOrigin" required errors={errors?.regionOfOrigin} placeholder="e.g. Ohio River valley" />
            <TextInput label="Estimated age or period" name="estimatedAge" required errors={errors?.estimatedAge} placeholder="e.g. Early Archaic" />
            <TextInput label="Materials" name="materials" required errors={errors?.materials} placeholder="e.g. Flint Ridge chert" />
            <div className="rounded-lg bg-white p-3 text-xs text-stone-700 ring-1 ring-amber-200">{iacaDisclosure}</div>
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" name="iacaAcknowledged" className="mt-0.5 h-4 w-4" />
              <span>
                I understand this disclosure. My listing does not claim the item is Indian-made or
                Native American-made.
              </span>
            </label>
            <Errors errors={errors?.iacaAcknowledged} />
          </div>
        )}
        {category?.requiresEnhancedReview && !nativeAmerican && (
          <p className="text-xs text-stone-500">This category gets an enhanced compliance review.</p>
        )}
      </section>

      <section className="space-y-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Price</h2>
        <TextInput
          label="Your asking price (USD)"
          name="askingPrice"
          required
          inputMode="decimal"
          placeholder="100.00"
          value={askingInput}
          onChange={setAskingInput}
          errors={errors?.askingPrice}
        />
        <dl className="grid grid-cols-3 gap-3 text-sm" aria-live="polite">
          <div className="rounded-xl bg-stone-50 p-4">
            <dt className="text-xs text-stone-500">Your asking price</dt>
            <dd className="mt-1 text-lg font-semibold">{prices ? formatUsd(prices.askingCents) : "—"}</dd>
          </div>
          <div className="rounded-xl bg-stone-50 p-4">
            <dt className="text-xs text-stone-500">Buyers see and pay</dt>
            <dd className="mt-1 text-lg font-semibold">{prices ? formatUsd(prices.buyerPriceCents) : "—"}</dd>
            <dd className="mt-1 text-xs text-stone-500">Asking + {pct(rates.buyerFeeBps)} buyer fee, built in</dd>
          </div>
          <div className="rounded-xl bg-emerald-50 p-4">
            <dt className="text-xs text-emerald-800">You receive</dt>
            <dd className="mt-1 text-lg font-semibold text-emerald-900">
              {prices ? formatUsd(prices.sellerPayoutCents) : "—"}
            </dd>
            <dd className="mt-1 text-xs text-emerald-800">Asking − {pct(rates.sellerFeeBps)} seller fee</dd>
          </div>
        </dl>
        <p className="text-xs text-stone-500">
          Buyers never pay a fee on top of the price they see. Shipping and any sales tax are shown
          separately at checkout.
        </p>
      </section>

      <section className="space-y-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Provenance</h2>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-stone-800">
            How did you acquire it?<span className="text-red-700"> *</span>
          </span>
          <select
            name="acquisitionSource"
            required
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className={inputClass}
          >
            <option value="">Choose…</option>
            {ACQUISITION_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <Errors errors={errors?.acquisitionSource} />
        </label>
        {source === "PRIVATE_LAND_WITH_PERMISSION" && (
          <TextInput label="Landowner's name" name="landownerName" required errors={errors?.landownerName} />
        )}
        <div className="grid grid-cols-2 gap-4">
          <TextInput
            label="State where acquired"
            name="acquisitionState"
            required={nativeAmerican || source === "PRIVATE_LAND_WITH_PERMISSION"}
            placeholder="KY"
            errors={errors?.acquisitionState}
          />
          <TextInput
            label="Year acquired (approx.)"
            name="acquisitionYearApprox"
            required={nativeAmerican}
            inputMode="numeric"
            placeholder="1995"
            errors={errors?.acquisitionYearApprox}
          />
        </div>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-stone-800">
            How and where you got it<span className="text-red-700"> *</span>
          </span>
          <textarea
            name="acquisitionDetails"
            required
            rows={3}
            className={inputClass}
            placeholder="e.g. Surface find on my family's farm in Boone County, KY after plowing in 1995."
          />
          <Errors errors={errors?.acquisitionDetails} />
        </label>
      </section>

      <section className="space-y-4 rounded-2xl border-2 border-stone-900 bg-white p-6 shadow-sm">
        {template.isDraft && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-red-800">
            Draft – pending lawyer review · statement v{template.version}
          </p>
        )}
        <h2 className="font-serif text-lg font-semibold">Sworn provenance statement</h2>
        <p className="whitespace-pre-line text-sm text-stone-700">{template.body}</p>
        <div className="space-y-3">
          {template.attestations.map((a) => (
            <label key={a.key} className="flex items-start gap-3 text-sm">
              <input type="checkbox" name="attestation" value={a.key} required className="mt-0.5 h-4 w-4" />
              <span>{a.text}</span>
            </label>
          ))}
          <Errors errors={errors?.attestationKeys} />
        </div>
        <TextInput
          label="Signature: type your full legal name"
          name="signedName"
          required
          hint={`Must match the name on your verified ID: ${legalName}`}
          errors={errors?.signedName}
        />
      </section>

      <FormMessage state={state} />
      <SubmitButton pending={pending}>Sign and submit for review</SubmitButton>
    </form>
  );
}
