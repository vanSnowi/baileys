export class ObjectRepository {
    constructor(entities = {}) {
        this.entityMap = new Map(Object.entries(entities));
    }

    findById(id) {
        return this.entityMap.get(id);
    }

    findAll() {
        return Array.from(this.entityMap.values());
    }

    upsertById(id, entity) {
        this.entityMap.set(id, { ...entity });
        return this;
    }

    deleteById(id) {
        return this.entityMap.delete(id);
    }

    count() {
        return this.entityMap.size;
    }

    toJSON() {
        return this.findAll();
    }
}

export default ObjectRepository;