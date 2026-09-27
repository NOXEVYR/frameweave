import unittest
from frameweave.packages import inspect_document, normalize_document, apply_values


class EditorFloatInputs(unittest.TestCase):
    def test_integer_serialized_float_can_be_adjusted_fractionally(self):
        info = {'PrimitiveFloat': {'input': {'required': {'value': ['FLOAT', {'min': 0, 'max': 10}]}}}}
        inspected = inspect_document({'1': {'class_type': 'PrimitiveFloat', 'inputs': {'value': 1}}}, info)
        field = inspected['fields'][0]
        self.assertEqual(field['type'], 'number')
        package = normalize_document(inspected)
        self.assertEqual(apply_values(package, {field['id']: 1.5})['1']['inputs']['value'], 1.5)
        with self.assertRaises(ValueError):
            apply_values(package, {field['id']: 10.5})
