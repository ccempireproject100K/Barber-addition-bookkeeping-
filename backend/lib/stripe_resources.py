"""Normalize verified/read Stripe resources at the application boundary."""


def stripe_dict(resource) -> dict:
    if isinstance(resource, dict):
        return resource
    convert = getattr(resource, "to_dict", None) or getattr(resource, "to_dict_recursive", None)
    if convert is None:
        raise TypeError("Expected a Stripe resource or dictionary")
    result = convert()
    if not isinstance(result, dict):
        raise TypeError("Stripe resource conversion did not return a dictionary")
    return result
