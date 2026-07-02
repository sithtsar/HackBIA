from backend.app.ontology import ONTOLOGY_PATH, build_graph, load_ontology, set_term_status, terms_from_ontology


def test_baseline_yaml_loads():
    onto = load_ontology()
    assert [s["table"] for s in onto["sources"]] == ["customers", "orders", "tickets"]
    assert len(onto["objects"]) == 3
    assert len(onto["joins"]) == 2
    assert len(onto["metrics"]) == 1


def test_build_graph_node_and_edge_counts():
    onto = load_ontology()
    graph = build_graph(onto)
    # nodes: 3 sources + 3 objects + 1 metric
    assert len(graph["nodes"]) == 7
    # edges: 3 feeds + 2 joins + 1 derives (m_active_customer -> obj_order)
    assert len(graph["edges"]) == 6

    by_id = {n["id"]: n for n in graph["nodes"]}
    assert by_id["src_customers"]["kind"] == "source"
    assert by_id["src_customers"]["status"] == "neutral"
    assert by_id["obj_customer"]["kind"] == "object"
    assert by_id["obj_customer"]["status"] == "approved"
    assert by_id["m_active_customer"]["kind"] == "metric"
    assert by_id["m_active_customer"]["status"] == "approved"

    edge_kinds = sorted(e["kind"] for e in graph["edges"])
    assert edge_kinds == sorted(["feeds", "feeds", "feeds", "join", "join", "derives"])

    join_edge = next(e for e in graph["edges"] if e["id"] == "join_orders_customers")
    assert join_edge["source"] == "obj_order"
    assert join_edge["target"] == "obj_customer"

    derives_edge = next(e for e in graph["edges"] if e["kind"] == "derives")
    assert derives_edge["source"] == "obj_order"
    assert derives_edge["target"] == "m_active_customer"


def test_build_graph_merges_extra_nodes_and_edges():
    onto = load_ontology()
    extra_nodes = [{"id": "insight_x", "kind": "insight", "label": "x", "status": "neutral", "meta": {}}]
    extra_edges = [{"id": "e_produces_act_0001", "source": "insight_x", "target": "act_0001", "kind": "produces"}]
    graph = build_graph(onto, extra_nodes=extra_nodes, extra_edges=extra_edges)
    assert len(graph["nodes"]) == 8
    assert len(graph["edges"]) == 7
    assert any(n["id"] == "insight_x" for n in graph["nodes"])


def test_terms_from_ontology_shapes():
    onto = load_ontology()
    terms = terms_from_ontology(onto)
    assert len(terms) == 3 + 2 + 1
    by_id = {t.id: t for t in terms}
    assert by_id["obj_customer"].sql == ""
    assert by_id["obj_customer"].confidence == 1.0
    assert by_id["obj_customer"].status == "approved"
    assert by_id["join_orders_customers"].confidence == 0.95
    assert by_id["m_active_customer"].status == "approved"


def test_set_term_status_mutates_and_persists(tmp_path):
    src = ONTOLOGY_PATH.read_text()
    tmp_yaml = tmp_path / "ontology.yaml"
    tmp_yaml.write_text(src)

    onto = load_ontology(tmp_yaml)
    found = set_term_status(onto, "m_active_customer", "rejected")
    assert found is True
    assert onto["metrics"][0]["status"] == "rejected"

    from backend.app.ontology import save_ontology
    save_ontology(onto, tmp_yaml)
    reloaded = load_ontology(tmp_yaml)
    assert reloaded["metrics"][0]["status"] == "rejected"

    missing = set_term_status(onto, "nope_not_a_real_id", "approved")
    assert missing is False
