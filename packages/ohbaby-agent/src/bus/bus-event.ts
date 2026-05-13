import type { z } from "zod";

export interface BusEventDefinition<
  Type extends string = string,
  Schema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly type: Type;
  readonly schema: Schema;
}

export type BusEventPayload<Event extends BusEventDefinition> = z.infer<
  Event["schema"]
>;

function define<Type extends string, Schema extends z.ZodTypeAny>(
  type: Type,
  schema: Schema,
): BusEventDefinition<Type, Schema> {
  return { type, schema };
}

export const BusEvent: {
  readonly define: <Type extends string, Schema extends z.ZodTypeAny>(
    type: Type,
    schema: Schema,
  ) => BusEventDefinition<Type, Schema>;
} = {
  define,
};
