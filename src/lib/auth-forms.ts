export type BootstrapFieldName =
  | "displayName"
  | "email"
  | "password"
  | "confirmPassword";

export type BootstrapFormState = {
  formError?: string;
  fieldErrors?: Partial<Record<BootstrapFieldName, string>>;
  values?: {
    displayName?: string;
    email?: string;
  };
};

export const EMPTY_BOOTSTRAP_FORM_STATE: BootstrapFormState = {
  fieldErrors: {},
  values: {},
};
