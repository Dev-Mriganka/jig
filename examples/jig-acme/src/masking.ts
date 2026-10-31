// Field names that hold customer personal data in the company's own systems and that Jig's built-in masking does not know.
// A real company lists the names its databases, logs and APIs use. Jig masks the usual ones by itself (email, phone, name,
// address, card and so on), so add only what is yours: a name that is only meaningful inside the company.
//
// The values of these fields become `personal#` tokens in production results. Names are compared without case or separators,
// so `memberAlias`, `member_alias` and `MemberAlias` are one name.
//
//   memberAlias        the nickname a member picked in the loyalty programme
//   loyaltyCardHolder  the name printed on a loyalty card
export const MASK_FIELDS: readonly string[] = ["memberAlias", "loyaltyCardHolder"];
