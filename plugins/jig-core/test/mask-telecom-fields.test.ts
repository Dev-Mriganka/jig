// Telecom field names that hold a person's number or contact: found unmasked in a company's data, and masked now by the
// word-based rules (see src/mask/kinds.ts). A descriptor keeps its field out of the rules (`mobileType`), and a name that only
// looks like one stays as it is (`client` is not `cli`).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fieldKind } from "../src/mask/kinds.ts";
import { maskText, maskValue } from "./mask-support.ts";

const NUMBER = "+442079460958";

/** Field names that hold a telephone number. */
const NUMBER_FIELDS = [
    "ani",
    "dnis",
    "cli",
    "fax",
    "faxNumber",
    "smsNumber",
    "mobile",
    "mobileNumber",
    "cell",
    "cellNumber",
    "destinationNumber",
    "originatingNumber",
    "portedNumber",
    "portingTn",
    "btn",
    "tnList",
    "didNumber",
    "dialedNumber",
    "dialableNumber",
    "callerNumber",
    "contactNumber",
    "callerId",
];

describe("telephone number fields", () => {
    for (const field of NUMBER_FIELDS) {
        it(`${field} is a phone field, and its number becomes a token that keeps the last four digits`, () => {
            assert.equal(fieldKind(field, ""), "phone");
            const masked = maskValue({ [field]: NUMBER })[field] as string;
            assert.match(masked, /^phone#[0-9a-f]{6}-0958$/);
            assert.ok(!masked.includes("2079460"), masked);
        });
    }

    it("a list of numbers is masked item by item, and so is a number written without a country code", () => {
        const masked = maskValue({ tnList: ["+12025550111", "2025550112"] });
        assert.match(masked.tnList[0], /^phone#[0-9a-f]{6}-0111$/);
        assert.match(masked.tnList[1], /^phone#[0-9a-f]{6}-0112$/);
    });

    it("a number written as a JSON number is a token too", () => {
        assert.match(maskValue({ ani: 2025550123 }).ani, /^phone#[0-9a-f]{6}-0123$/);
    });

    it("a value that is not a number is removed whole, as in any phone field", () => {
        assert.equal(maskValue({ cell: "not a number" }).cell, "[removed:phone]");
    });

    it("the same number gives the same token in every field", () => {
        const masked = maskValue({ ani: NUMBER, mobileNumber: NUMBER, callerId: "+44 20 7946 0958" });
        assert.equal(masked.ani, masked.mobileNumber);
        assert.equal(masked.ani, masked.callerId);
    });

    it("the spelling of the name does not matter: snake case, upper case, a squashed run, a dotted path", () => {
        for (const field of [
            "fax_number",
            "FAX_NUMBER",
            "faxnumber",
            "mobile_number",
            "mobilenumber",
            "cellnumber",
            "caller_id",
            "CallerID",
            "callerid",
            "did_number",
            "didnumber",
            "dialed_number",
            "DNIS",
            "ANI",
            "Mobile",
            "tn_list",
            "porting_tn",
            "destination_number",
            "originating_number",
            "ported_number",
            "sms_number",
            "cli_number",
            "btn_number",
        ]) {
            assert.equal(fieldKind(field, ""), "phone", field);
        }
        assert.equal(fieldKind("call.callerId", ""), "phone", "the last part of a path decides");
    });

    it("callerId is a number although it ends in id, and callerIdName is a name", () => {
        assert.equal(fieldKind("callerId", ""), "phone");
        assert.equal(fieldKind("callerIdNumber", ""), "phone");
        assert.equal(fieldKind("callerIdName", ""), "name");
        assert.match(maskValue({ callerIdName: "Casey Sample" }).callerIdName, /^name#/);
        assert.equal(fieldKind("callerIdType", ""), "other");
        assert.equal(fieldKind("callId", ""), "safe");
        assert.equal(fieldKind("callerRef", ""), "other");
    });

    it("the rules that were there still hold", () => {
        for (const field of ["tn", "did", "called", "callingNumber", "calledNumber", "phone", "msisdn"]) {
            assert.equal(fieldKind(field, ""), "phone", field);
        }
        assert.equal(fieldKind("from", "cdr"), "phone");
        assert.equal(fieldKind("from", "request"), "other");
    });

    it("they are masked in log lines and URL queries too", () => {
        const line = maskText(`INFO routed ani=${NUMBER} dnis=+12025550111 mobile=2025550123 call=c-1`);
        for (const leaked of ["2079460", "202555011", "202555012"]) assert.ok(!line.includes(leaked), line);
        assert.equal(line.match(/phone#/g)?.length, 3, line);
        assert.ok(line.includes("call=c-1"));
        const query = maskText(`GET /v1/route?cli=${NUMBER}&faxNumber=%2B12025550111&order=o-7`);
        assert.ok(!query.includes("2079460") && !query.includes("%2B1202555011"), query);
        assert.ok(query.includes("order=o-7"), query);
    });
});

describe("a descriptor keeps the field out of the rules", () => {
    for (const field of [
        "mobileType",
        "mobileFormat",
        "cellCount",
        "faxEnabled",
        "faxVerified",
        "tnCount",
        "tnTotal",
        "portingTnStatus",
        "callerIdType",
        "callerIdFormat",
        "callerIdEnabled",
        "ani_format",
        "dnisCount",
        "cliVersion",
        "cli_mode",
        "btnLength",
        "sipUriPattern",
        "contactType",
        "contactCount",
        "primaryContactStatus",
        "billToContactVerified",
    ]) {
        it(`${field} stays as it is`, () => {
            assert.equal(fieldKind(field, ""), "other");
            assert.deepEqual(maskValue({ [field]: "text-1" }), { [field]: "text-1" });
        });
    }
});

describe("a name that only looks like one is left alone", () => {
    for (const field of [
        "client",
        "clientId",
        "client_version",
        "cliente",
        "clip",
        "click",
        "clicks",
        "climate",
        "cliff",
        "cellTower",
        "cell_site",
        "cellId",
        "cellular",
        "cellar",
        "mobileApp",
        "mobileCarrier",
        "mobileOs",
        "faxServer",
        "faxMachine",
        "anime",
        "anita",
        "animal",
        "banner",
        "tnx",
        "destination",
        "destinationHost",
        "destinationPort",
        "originating",
        "originatingSystem",
        "portedFrom",
        "porting",
        "sip",
        "sipHost",
        "sipTrunk",
        "uri",
        "callerRef",
        "dialed",
        "dialable",
        "sms",
        "smsBody",
        "btnColor",
    ]) {
        it(`${field} is not a telephone number or a contact`, () => {
            assert.ok(["other", "identifier"].includes(fieldKind(field, "")), `${field}: ${fieldKind(field, "")}`);
        });
    }

    it("cli is a number only as a name of its own, and client in every spelling is not cli", () => {
        assert.equal(fieldKind("cli", ""), "phone");
        assert.deepEqual(maskValue({ client: "curl/8.0", clientVersion: "1.2", clip: "a.mp4" }), {
            client: "curl/8.0",
            clientVersion: "1.2",
            clip: "a.mp4",
        });
        assert.equal(maskText("INFO client=curl/8.0 cli=+442079460958").includes("client=curl/8.0"), true);
    });

    it("the other fields of a call record are still read as they were", () => {
        assert.deepEqual(
            maskValue({ mobileCarrier: "Example Mobile", cellTower: "t-44", faxServer: "fax-1", callId: "c-9" }),
            { mobileCarrier: "Example Mobile", cellTower: "t-44", faxServer: "fax-1", callId: "c-9" },
        );
    });
});

describe("a SIP address", () => {
    it("is a personal token, because it names a person or a line and is not a bare number", () => {
        assert.equal(fieldKind("sipUri", ""), "personal");
        assert.equal(fieldKind("sip_uri", ""), "personal");
        assert.equal(fieldKind("siputi", ""), "other");
        const masked = maskValue({ sipUri: "sip:casey@example.com", sipuri: "sip:+442079460958@example.com" });
        assert.match(masked.sipUri, /^personal#[0-9a-f]{6}$/);
        assert.match(masked.sipuri, /^personal#[0-9a-f]{6}$/);
        assert.ok(!JSON.stringify(masked).includes("casey"));
    });

    it("gives the same token for the same address", () => {
        const masked = maskValue({ sipUri: "sip:casey@example.com", to: { sipUri: "sip:casey@example.com" } });
        assert.equal(masked.sipUri, masked.to.sipUri);
    });
});

describe("contact fields", () => {
    for (const field of [
        "contact",
        "billToContact",
        "soldToContact",
        "adminContact",
        "primaryContact",
        "technicalContact",
        "billingContact",
        "accountContact",
    ]) {
        it(`${field}: a scalar is a personal token`, () => {
            assert.equal(fieldKind(field, ""), "contact");
            assert.match(maskValue({ [field]: "Casey Sample" })[field], /^personal#[0-9a-f]{6}$/);
            assert.match(maskValue({ [field]: 4471 })[field], /^personal#[0-9a-f]{6}$/, "a number too");
            assert.equal(maskValue({ [field]: null })[field], null);
        });
    }

    it("the spelling of the name does not matter", () => {
        for (const field of [
            "bill_to_contact",
            "BILL_TO_CONTACT",
            "Primary_Contact",
            "primarycontact",
            "billingcontact",
            "accountcontact",
            "admincontact",
            "technicalcontact",
            "CONTACT",
        ]) {
            assert.equal(fieldKind(field, ""), "contact", field);
        }
    });

    it("an object is not masked whole: its own fields decide, and what is not personal stays readable", () => {
        const masked = maskValue({
            billToContact: {
                id: "c-12",
                country: "US",
                state: "NJ",
                firstName: "Casey",
                workEmail: "casey@example.com",
                address1: "4 Test Lane",
                nickname: "kc",
                tier: 2,
            },
            contact: { type: "primary", count: 3, mobile: NUMBER },
        });
        assert.equal(masked.billToContact.id, "c-12");
        assert.equal(masked.billToContact.country, "US");
        assert.equal(masked.billToContact.state, "NJ");
        assert.equal(masked.billToContact.tier, 2);
        assert.match(masked.billToContact.firstName, /^name#/);
        assert.match(masked.billToContact.workEmail, /^email#/);
        assert.equal(masked.billToContact.address1, "[removed:address]");
        assert.equal(masked.contact.type, "primary");
        assert.equal(masked.contact.count, 3);
        assert.match(masked.contact.mobile, /^phone#/);
    });

    it("a list of scalars is masked item by item, and a list of objects is read field by field", () => {
        const masked = maskValue({
            primaryContact: ["Casey Sample", "Robin Example"],
            adminContact: [{ country: "US", firstName: "Casey" }],
        });
        assert.ok(masked.primaryContact.every((item: string) => /^personal#/.test(item)));
        assert.equal(masked.adminContact[0].country, "US");
        assert.match(masked.adminContact[0].firstName, /^name#/);
    });

    it("the same value gives the same token, and a different one a different token", () => {
        const masked = maskValue({ contact: "Casey Sample", adminContact: "Casey Sample", billingContact: "Robin" });
        assert.equal(masked.contact, masked.adminContact);
        assert.notEqual(masked.contact, masked.billingContact);
    });

    it("other fields of a contact keep their own rules", () => {
        assert.equal(fieldKind("contactEmail", ""), "email");
        assert.equal(fieldKind("contactName", ""), "name");
        assert.equal(fieldKind("contactPhone", ""), "phone");
        assert.equal(fieldKind("contactNumber", ""), "phone");
        assert.equal(fieldKind("contactId", ""), "identifier");
        assert.equal(fieldKind("contactType", ""), "other");
        assert.equal(fieldKind("contacts", ""), "other");
        assert.equal(fieldKind("contactMethod", ""), "other");
    });

    it("is masked in log lines and URL queries when it holds a scalar", () => {
        const line = maskText("INFO updated billToContact=Casey order=o-7");
        assert.ok(!line.includes("Casey"), line);
        assert.match(line, /billToContact=personal#[0-9a-f]{6}/);
        assert.ok(line.includes("order=o-7"));
        const query = maskText("GET /v1/accounts?primaryContact=Casey&page=2");
        assert.ok(!query.includes("Casey"), query);
        assert.ok(query.includes("page=2"));
    });
});
