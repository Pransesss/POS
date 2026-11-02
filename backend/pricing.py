"""Meal pricing — the ONLY place that decides a price. The browser shows a preview, the server recomputes with this.

A sale line (spec) coming from the POS looks like one of:
  {"type": "meal", "meat": "beef", "meat_qty": 1, "veg_qty": 1, "rice_type": "plain", "rice_qty": 1, "qty": 2}
  {"type": "meat", "meat": "pork", "qty": 1}          meat only (single serving)
  {"type": "veg" | "rice" | "fried_rice", "qty": 1}
  {"type": "product", "product_id": 12, "qty": 3}      snack / drink / chips ...
"""
from decimal import Decimal

MEATS = ("beef", "chicken", "fish", "pork")


class SaleError(ValueError):
    pass


def D(x):
    return Decimal(str(x))


def _num(spec, key, allowed, default):
    v = spec.get(key, default)
    try:
        v = float(v)
    except (TypeError, ValueError):
        raise SaleError(f"bad {key}")
    if v not in allowed:
        raise SaleError(f"bad {key}")
    return v


def build_line(spec, mp, product=None):
    """Return the priced line. `mp` = {price_key: Decimal}. `product` = product row (only for type 'product')."""
    qty = int(spec.get("qty", 1))
    if not 1 <= qty <= 99:
        raise SaleError("bad qty")
    t = spec.get("type")
    base = dict(qty=qty, product_id=None, meat=None, meat_qty=None, veg_qty=None, rice_type=None, rice_qty=None, is_budget=False)

    if t == "meal":
        meat = spec.get("meat") or None
        if meat is not None and meat not in MEATS:
            raise SaleError("bad meat")
        mq = _num(spec, "meat_qty", (1, 2), 1)
        veg = _num(spec, "veg_qty", (0, 1, 2), 0)
        rice_type = spec.get("rice_type", "plain")
        if rice_type not in ("plain", "fried"):
            raise SaleError("bad rice type")
        rq = _num(spec, "rice_qty", (0.5, 1, 2), 1)
        if not meat and not veg:
            raise SaleError("choose a meat or veggy")
        # plain rice + ONE meat + veggy = BUDGET MEAL (fixed price on the list)
        budget = bool(meat) and mq == 1 and veg == 1 and rice_type == "plain" and rq == 1
        rice_price = mp["fried_rice"] if rice_type == "fried" else mp["rice"]
        if budget:
            price = mp["budget_" + meat]
        else:
            price = (mp[meat] * D(mq) if meat else D(0)) + mp["veg"] * D(veg) + rice_price * D(rq)
        kinds = []
        if budget:
            kinds.append("Budget meal")
        else:
            if mq == 2: kinds.append("Double meat")
            if rq == 2: kinds.append("Double rice")
            if rq == 0.5: kinds.append("Half rice")
            if veg == 2: kinds.append("Double veggy")
            if not kinds: kinds.append("Rice + meat" if meat else "Rice + veggy")
        rice_txt = ("½ " if rq == 0.5 else "Double " if rq == 2 else "") + ("Fried rice" if rice_type == "fried" else "Rice")
        if budget:
            name = f"Budget Meal (Rice, {meat.capitalize()} & Vegetable)"
        else:
            bits = [rice_txt]
            if meat: bits.append(("Double " if mq == 2 else "") + meat.capitalize())
            if veg: bits.append(("Double " if veg == 2 else "") + "Vegetable")
            name = " + ".join(bits)
        parts = {"rice": D(rq)}
        if meat: parts[meat] = D(mq)
        if veg: parts["veg"] = D(veg)
        base.update(name=name, section="Meals", kind=" + ".join(kinds), unit_price=price, parts=parts,
                    meat=meat, meat_qty=mq if meat else None, veg_qty=veg, rice_type=rice_type, rice_qty=rq, is_budget=budget)
        return base

    if t == "meat":
        meat = spec.get("meat")
        if meat not in MEATS:
            raise SaleError("bad meat")
        base.update(name=meat.capitalize(), section="Meals", kind="Meat only", unit_price=mp[meat], parts={meat: D(1)}, meat=meat, meat_qty=1)
        return base
    if t == "veg":
        base.update(name="Veggy", section="Meals", kind="Veggy only", unit_price=mp["veg"], parts={"veg": D(1)}, veg_qty=1)
        return base
    if t == "rice":
        base.update(name="Plain Rice", section="Meals", kind="Rice only", unit_price=mp["rice"], parts={"rice": D(1)}, rice_type="plain", rice_qty=1)
        return base
    if t == "fried_rice":
        base.update(name="Fried Rice", section="Meals", kind="Fried rice only", unit_price=mp["fried_rice"], parts={"rice": D(1)}, rice_type="fried", rice_qty=1)
        return base
    if t == "product":
        if not product or not product["is_active"]:
            raise SaleError("product not available")
        base.update(name=product["name"], section="Snacks", kind=None, unit_price=product["price"], parts={}, product_id=product["product_id"])
        return base
    raise SaleError("unknown line type")
